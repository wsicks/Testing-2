// Market scanner + signal pipeline. Runs on demand (POST /api/signals/scan)
// and in the background (interval loop started lazily, or the dedicated
// `npm run worker` process). Every produced signal is persisted with its
// checks and pushed to the live feed.

import {
  SCAN_MIN_INTERVAL,
  SCANNER_BOOK_LIMIT,
} from "@/lib/constants";
import { runAllStrategies } from "@/lib/engine/signals/registry";
import type { OrderBookData, RecentTrade, SignalResult } from "@/lib/types";
import { audit } from "./audit";
import { autopilotTick } from "./autopilot";
import { publishFeed } from "./events";
import { measure, measureSync, recordLatency } from "./perf";
import { getBook, getHistory, getMarkets, getTrades } from "./marketData";
import { maybeSnapshotPortfolio } from "./portfolio";
import { settleOpenOrders } from "./execution";
import { getStore } from "./store";

interface ScannerGlobal {
  lastScanAt: number;
  lastPrices: Map<string, number>;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}

const g = globalThis as unknown as { __pqScanner?: ScannerGlobal };

function state(): ScannerGlobal {
  if (!g.__pqScanner) {
    g.__pqScanner = {
      lastScanAt: 0,
      lastPrices: new Map(),
      timer: null,
      running: false,
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
    const histories = new Map<string, { t: number; p: number }[]>();
    const tapes = new Map<string, RecentTrade[]>();
    for (const m of top) {
      if (!m.yesTokenId) continue;
      try {
        books.set(m.conditionId, await getBook(m.yesTokenId, m.midpoint));
        histories.set(m.conditionId, await getHistory(m.yesTokenId, "1d", 30));
        tapes.set(m.conditionId, await getTrades(m.conditionId));
      } catch {
        /* enrichment is best-effort */
      }
    }

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
        runAllStrategies({
          market: m,
          book: books.get(m.conditionId),
          history: histories.get(m.conditionId),
          trades: tapes.get(m.conditionId),
          relatedMarkets: m.volume24h >= 10_000 ? markets : undefined,
          settings,
          now,
        }),
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

    // housekeeping piggybacked on the scan tick
    await settleOpenOrders("paper");
    await maybeSnapshotPortfolio("paper");
    // autopilot runs after fresh signals land — exits, breakers, entries
    try {
      const ap = await measure("autopilot.tick", () => autopilotTick());
      if (ap.ran && (ap.entries || ap.exits)) {
        publishFeed("scanner_tick", `Autopilot tick: ${ap.entries} entr${ap.entries === 1 ? "y" : "ies"}, ${ap.exits} exit(s)`, {});
      }
    } catch (err) {
      console.error("[polyquant] autopilot tick failed:", err);
    }
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

/** Lazily start the in-process background scanner loop (30s cadence). */
export function ensureBackgroundScanner(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => {
    scanOnce(false).catch((err) =>
      console.error("[polyquant] scan tick failed:", err),
    );
  }, 30_000);
  // do not keep the process alive just for the scanner
  if (typeof s.timer === "object" && "unref" in s.timer) s.timer.unref();
}
