// Market scanner + signal pipeline. Runs on demand (POST /api/signals/scan)
// and in the background (interval loop started lazily, or the dedicated
// `npm run worker` process). Every produced signal is persisted with its
// checks and pushed to the live feed.

import {
  SCAN_MIN_INTERVAL,
  SCANNER_BOOK_LIMIT,
} from "@/lib/constants";
import { runAllStrategies } from "@/lib/engine/signals/registry";
import { parseCryptoThreshold } from "@/lib/engine/crossvenue/threshold";
import type { OrderBookData, RecentTrade, SignalContext, SignalResult } from "@/lib/types";
import { audit } from "./audit";
import { autopilotTick } from "./autopilot";
import { getCrossVenueLinks } from "./crossVenue";
import { publishFeed } from "./events";
import { measure, measureSync, recordLatency } from "./perf";
import {
  getBook,
  getHistory,
  getMarkets,
  getRealizedVolDaily,
  getSpotRef,
  getTrades,
} from "./marketData";
import { maybeSnapshotPortfolio } from "./portfolio";
import { settleOpenOrders } from "./execution";
import { getStore } from "./store";
import { ensureFoundryTicker } from "./alpha/foundry";
import { logError } from "./errorLog";
import { pushSignals } from "./hotpath/signalCache";
import { getBaseline, updateBaselines } from "./hotpath/baselines";
import { swapBookSnapshot } from "./hotpath/bookMemory";
import { runArbExecutor } from "./alpha/arbExecutor";
import { runMimicExecutor } from "./alpha/mimic";
import { trackSignalOutcomes } from "./alpha/outcomes";
import { getWalletIntel } from "./alpha/walletRadar";

interface ScannerGlobal {
  lastScanAt: number;
  lastPrices: Map<string, number>;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  /** completed scan passes since process start — a real counter, not a clock */
  cycles: number;
}

const g = globalThis as unknown as { __pqScanner?: ScannerGlobal };

function state(): ScannerGlobal {
  if (!g.__pqScanner) {
    g.__pqScanner = {
      lastScanAt: 0,
      lastPrices: new Map(),
      timer: null,
      running: false,
      cycles: 0,
    };
  }
  return g.__pqScanner;
}

export interface ScanSummary {
  scanned: number;
  booksFetched: number;
  signalsCreated: number;
  signalsRejected: number;
  skipped: boolean;
}

export async function scanOnce(force = false): Promise<ScanSummary> {
  const s = state();
  const store = await getStore();
  const settings = await store.getSettings();
  if (s.running) return { scanned: 0, booksFetched: 0, signalsCreated: 0, signalsRejected: 0, skipped: true };
  if (!force && Date.now() - s.lastScanAt < SCAN_MIN_INTERVAL) {
    return { scanned: 0, booksFetched: 0, signalsCreated: 0, signalsRejected: 0, skipped: true };
  }
  if (!settings.scannersEnabled && !force) {
    return { scanned: 0, booksFetched: 0, signalsCreated: 0, signalsRejected: 0, skipped: true };
  }

  s.running = true;
  s.lastScanAt = Date.now();
  const tickStart = performance.now();
  try {
    const { markets } = await getMarkets();
    const now = Date.now();

    // rolling spread/liquidity baselines — one in-memory pass per scan
    measureSync("hot.baseline_update", () => updateBaselines(markets, now));

    // price-move feed events vs previous scan
    for (const m of markets) {
      const prev = s.lastPrices.get(m.conditionId);
      const cur = m.yesPrice;
      if (prev !== undefined && cur !== undefined && Math.abs(cur - prev) >= 0.02) {
        publishFeed(
          "price_moved",
          `${m.question.slice(0, 60)} moved ${((cur - prev) * 100).toFixed(1)}c to ${(cur * 100).toFixed(1)}c`,
          { data: { conditionId: m.conditionId, from: prev, to: cur } },
        );
      }
      if (cur !== undefined) s.lastPrices.set(m.conditionId, cur);
      if (prev === undefined && m.isNew) {
        publishFeed("market_discovered", `New market: ${m.question.slice(0, 70)}`, {
          data: { conditionId: m.conditionId },
        });
      }
    }

    // book + history enrichment for the most active markets
    const top = [...markets]
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, SCANNER_BOOK_LIMIT);
    const books = new Map<string, OrderBookData>();
    const prevBooks = new Map<string, OrderBookData>();
    const histories = new Map<string, { t: number; p: number }[]>();
    const tapes = new Map<string, RecentTrade[]>();
    for (const m of top) {
      if (!m.yesTokenId) continue;
      try {
        const book = await getBook(m.yesTokenId, m.midpoint);
        books.set(m.conditionId, book);
        const prev = swapBookSnapshot(m.yesTokenId, book);
        if (prev) prevBooks.set(m.conditionId, prev);
        histories.set(m.conditionId, await getHistory(m.yesTokenId, "1d", 30));
        tapes.set(m.conditionId, await getTrades(m.conditionId));
      } catch {
        /* enrichment is best-effort */
      }
    }

    // cross-venue enrichment: links (cached 60s) + fresh Coinbase reference
    // spot/vol for every product referenced by a crypto-threshold market
    const crossLinks = await getCrossVenueLinks().catch(() => []);
    const refProducts = new Set<string>();
    for (const m of markets) {
      if (m.outcomeType !== "binary") continue;
      const th = parseCryptoThreshold(m.question, m.endDate);
      if (th?.coinbaseProduct) refProducts.add(th.coinbaseProduct);
    }
    const spotRefs = new Map<string, NonNullable<SignalContext["reference"]>>();
    for (const product of [...refProducts].slice(0, 8)) {
      const spot = await getSpotRef(product).catch(() => undefined);
      if (!spot) continue;
      const vol = await getRealizedVolDaily(product).catch(() => undefined);
      spotRefs.set(product, {
        spot: spot.price,
        spotSource: `coinbase:${product}`,
        spotFreshnessMs: Date.now() - spot.ts,
        realizedVolDaily: vol,
      });
    }
    const referenceFor = (m: (typeof markets)[number]) => {
      if (m.outcomeType !== "binary") return undefined;
      const th = parseCryptoThreshold(m.question, m.endDate);
      return th?.coinbaseProduct ? spotRefs.get(th.coinbaseProduct) : undefined;
    };

    // dedupe: skip signals repeated for the same strategy+market within 10 min
    const recent = await store.listSignals({ limit: 400 });
    const seen = new Set(
      recent
        .filter((x) => now - x.createdAt < 10 * 60_000)
        .map((x) => `${x.strategy}:${x.conditionId}`),
    );

    const created: SignalResult[] = [];
    let rejected = 0;
    for (const m of markets) {
      // per-market signal scoring is a hot.* metric (<20ms p95 budget).
      // cross-market relation scans are O(universe) per market, so they only
      // run for markets liquid enough to ever pass the risk engine.
      const results = measureSync("hot.signal_market", () =>
        runAllStrategies(
          {
            market: m,
            book: books.get(m.conditionId),
            prevBook: prevBooks.get(m.conditionId),
            history: histories.get(m.conditionId),
            trades: tapes.get(m.conditionId),
            relatedMarkets: m.volume24h >= 10_000 ? markets : undefined,
            reference: referenceFor(m),
            crossLinks,
            // cold-path built by the Wallet Radar ticker; in-memory read here
            walletIntel: getWalletIntel(m.conditionId),
            baseline: getBaseline(m.conditionId),
            alpha: settings.alpha,
            settings,
            now,
          },
          (strategyId, err) => logError(`strategy:${strategyId}`, err, m.conditionId),
        ),
      );
      for (const sig of results) {
        if (seen.has(`${sig.strategy}:${sig.conditionId}`)) continue;
        seen.add(`${sig.strategy}:${sig.conditionId}`);
        created.push(sig);
        if (sig.status === "rejected") rejected += 1;
      }
    }

    // keep the highest-scoring signals PER STRATEGY so informational
    // (always-100) screens can't crowd out directional strategies
    created.sort((a, b) => b.score - a.score);
    const perStrategy = new Map<string, SignalResult[]>();
    for (const sig of created) {
      const list = perStrategy.get(sig.strategy) ?? [];
      if (list.length < 8) {
        list.push(sig);
        perStrategy.set(sig.strategy, list);
      }
    }
    const toPersist = [...perStrategy.values()].flat().slice(0, 56);
    if (toPersist.length) {
      await store.addSignals(toPersist);
      pushSignals(toPersist); // hot in-memory ring for dashboard reads
      for (const sig of toPersist.slice(0, 8)) {
        publishFeed(
          sig.status === "rejected" ? "signal_rejected" : "signal_created",
          `[${sig.strategyLabel}] ${sig.score}/100 ${sig.marketQuestion?.slice(0, 55) ?? ""} — ${sig.summary.slice(0, 80)}`,
          { severity: sig.status === "rejected" ? "warn" : "info", data: { signalId: sig.id } },
        );
      }
      await audit(
        "scanner",
        "scan_complete",
        `Scan: ${markets.length} markets → ${created.length} candidate signal(s), top ${toPersist.length} kept (${toPersist.filter((x) => x.status === "rejected").length} of those self-rejected)`,
        { data: { markets: markets.length, candidates: created.length, kept: toPersist.length } },
      );
    }

    // Alpha Foundry: measure forward drift for every persisted directional
    // signal (proposed AND self-rejected — both are evidence), then run the
    // paper mimic/fade executor when the follow mode allows it
    try {
      await trackSignalOutcomes(toPersist, markets);
      await runMimicExecutor(toPersist, markets);
    } catch (err) {
      logError("scanner:outcomes_mimic", err);
      console.error("[eventquant] alpha outcome/mimic step failed:", err);
    }
    // complement arbitrage: math-locked YES+NO pairs when both books sum
    // under $1 net of fees (paper book; isolated like every other step)
    try {
      const arb = await runArbExecutor(markets);
      if (arb.paired > 0) {
        publishFeed(
          "order_filled",
          `Complement arb: ${arb.paired} pair(s), $${arb.lockedNetUsd.toFixed(2)} locked at resolution (paper)`,
          {},
        );
      }
    } catch (err) {
      logError("arb:executor", err);
    }

    // housekeeping piggybacked on the scan tick (settlement is mutex-guarded).
    // Each step is isolated: a settlement failure must never prevent the
    // autopilot exit sweep below from running — exits are the safety net.
    try {
      await settleOpenOrders("paper");
      await settleOpenOrders("demo");
    } catch (err) {
      logError("execution:settle", err);
    }
    try {
      await maybeSnapshotPortfolio("paper");
    } catch (err) {
      logError("portfolio:snapshot", err);
    }
    // autopilot runs after fresh signals land — exits, breakers, entries
    try {
      const ap = await measure("autopilot.tick", () => autopilotTick());
      if (ap.ran && (ap.entries || ap.exits)) {
        publishFeed("scanner_tick", `Autopilot tick: ${ap.entries} entr${ap.entries === 1 ? "y" : "ies"}, ${ap.exits} exit(s)`, {});
      }
    } catch (err) {
      logError("autopilot:tick", err);
      console.error("[eventquant] autopilot tick failed:", err);
    }
    s.cycles += 1;
    recordLatency("scan.tick_total", performance.now() - tickStart);
    publishFeed("scanner_tick", `Scanner pass: ${markets.length} markets, ${toPersist.length} new signal(s)`, {
      data: { markets: markets.length },
    });

    return {
      scanned: markets.length,
      booksFetched: books.size,
      signalsCreated: toPersist.length,
      signalsRejected: rejected,
      skipped: false,
    };
  } finally {
    s.running = false;
  }
}

/** completed scan passes since process start */
export function scanCycles(): number {
  return state().cycles;
}

/**
 * Lazily start the in-process background scanner loop (30s cadence).
 * Set DISABLE_EMBEDDED_SCANNER=true on the web process when the dedicated
 * worker owns scheduling — two schedulers would double-run the autopilot.
 */
export function ensureBackgroundScanner(): void {
  if (process.env.DISABLE_EMBEDDED_SCANNER === "true") return;
  ensureFoundryTicker();
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => {
    scanOnce(false).catch((err) => {
      logError("scanner:tick", err);
      console.error("[eventquant] scan tick failed:", err);
    });
  }, 30_000);
  // do not keep the process alive just for the scanner
  if (typeof s.timer === "object" && "unref" in s.timer) s.timer.unref();
}
