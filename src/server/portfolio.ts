// Portfolio state computation per mode.
//  demo  → seeded sample account, always labeled isSample
//  paper → real accounting over store fills/positions, marked at live prices
//  live  → read-only wallet analytics via the public Data API (no keys)

import type { PortfolioState, PositionRecord, TerminalMode } from "@/lib/types";
import { demoAccount } from "@/lib/demo/demoData";
import { fetchUserPositions } from "@/lib/polymarket/dataapi";
import { venueForToken } from "@/lib/venues/registry";
import { genId } from "@/lib/utils";
import { cached } from "./cache";
import { getMarkets, priceLookup } from "./marketData";
import { getStore } from "./store";

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function computePortfolio(mode: TerminalMode): Promise<PortfolioState> {
  if (mode === "demo") {
    const { markets } = await getMarkets();
    return demoAccount(markets).portfolio;
  }
  if (mode === "live") return computeLivePortfolio();
  return computePaperPortfolio();
}

async function computePaperPortfolio(): Promise<PortfolioState> {
  const store = await getStore();
  const [positionsRaw, account, fills, snapshots] = await Promise.all([
    store.listPositions("paper"),
    store.getAccount("paper"),
    store.listFills("paper"),
    store.listPortfolioSnapshots("paper", 2000),
  ]);
  const marks = await priceLookup();

  const positions: PositionRecord[] = positionsRaw
    .filter((p) => p.size > 0 || p.realizedPnl !== 0)
    .map((p) => {
      const mark = marks.get(p.tokenId) ?? p.avgPrice;
      return {
        ...p,
        markPrice: mark,
        unrealizedPnl: Number(((mark - p.avgPrice) * p.size).toFixed(2)),
        value: Number((mark * p.size).toFixed(2)),
      };
    });

  const open = positions.filter((p) => p.size > 0);
  const exposure = open.reduce((a, p) => a + (p.value ?? 0), 0);
  const unrealized = open.reduce((a, p) => a + (p.unrealizedPnl ?? 0), 0);
  const realized = positions.reduce((a, p) => a + p.realizedPnl, 0);
  const totalValue = account.cash + exposure;

  const exposureByMarket: Record<string, number> = {};
  const exposureByCategory: Record<string, number> = {};
  const exposureByVenue: Record<string, number> = {};
  for (const p of open) {
    const mk = p.conditionId ?? p.tokenId;
    exposureByMarket[mk] = (exposureByMarket[mk] ?? 0) + (p.value ?? 0);
    const cat = p.category ?? "Uncategorized";
    exposureByCategory[cat] = (exposureByCategory[cat] ?? 0) + (p.value ?? 0);
    const venue = venueForToken(p.tokenId);
    exposureByVenue[venue] = (exposureByVenue[venue] ?? 0) + (p.value ?? 0);
  }

  // realized-trade statistics from SELL fills that carry realized PnL
  const closed = fills.filter((f) => f.realizedPnlDelta !== undefined);
  const wins = closed.filter((f) => (f.realizedPnlDelta ?? 0) > 0);
  const losses = closed.filter((f) => (f.realizedPnlDelta ?? 0) < 0);
  const avgWin = wins.length
    ? wins.reduce((a, f) => a + (f.realizedPnlDelta ?? 0), 0) / wins.length
    : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((a, f) => a + (f.realizedPnlDelta ?? 0), 0)) / losses.length
    : 0;

  const dayStart = startOfToday();
  const dailyRealized = closed
    .filter((f) => f.ts >= dayStart)
    .reduce((a, f) => a + (f.realizedPnlDelta ?? 0), 0);

  // daily PnL against the last snapshot before local midnight
  const baseline = [...snapshots].reverse().find((s) => s.ts < dayStart);
  const dailyPnl = baseline ? totalValue - baseline.totalValue : dailyRealized;

  // max drawdown over the snapshot equity path
  let peak = -Infinity;
  let maxDd = 0;
  for (const s of [...snapshots, { totalValue }]) {
    peak = Math.max(peak, s.totalValue);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - s.totalValue) / peak);
  }

  // liquidity risk: position value vs market liquidity, exposure-weighted
  const { markets } = await getMarkets();
  const liqByCondition = new Map(markets.map((m) => [m.conditionId, m.liquidity]));
  let liqRisk = 0;
  if (exposure > 0) {
    for (const p of open) {
      const liq = liqByCondition.get(p.conditionId ?? "") ?? 0;
      const ratio = liq > 0 ? Math.min(1, (p.value ?? 0) / (liq * 0.1)) : 1;
      liqRisk += ((p.value ?? 0) / exposure) * ratio;
    }
  }

  return {
    mode: "paper",
    cash: Number(account.cash.toFixed(2)),
    totalValue: Number(totalValue.toFixed(2)),
    exposure: Number(exposure.toFixed(2)),
    positions,
    exposureByMarket,
    exposureByCategory,
    exposureByVenue,
    realizedPnl: Number(realized.toFixed(2)),
    unrealizedPnl: Number(unrealized.toFixed(2)),
    dailyPnl: Number(dailyPnl.toFixed(2)),
    dailyRealizedPnl: Number(dailyRealized.toFixed(2)),
    allTimePnl: Number((totalValue - account.startingCash).toFixed(2)),
    winRate: closed.length ? wins.length / closed.length : undefined,
    avgRR: avgLoss > 0 ? Number((avgWin / avgLoss).toFixed(2)) : undefined,
    maxDrawdown: Number(maxDd.toFixed(4)),
    liquidityRiskScore: Number(liqRisk.toFixed(2)),
    closedTrades: closed.length,
    isSample: false,
  };
}

async function computeLivePortfolio(): Promise<PortfolioState> {
  const store = await getStore();
  const settings = await store.getSettings();
  const wallet = settings.watchWallet || process.env.NEXT_PUBLIC_WATCH_WALLET;
  // live cash is USER-DECLARED (the app holds no keys and cannot read venue
  // balances). Default $0 keeps every live BUY fail-closed until the user
  // explicitly asserts a bankroll in Settings → Risk — labeled as declared
  // there, and used ONLY as the risk engine's sizing/cash ceiling.
  const declaredCash = Math.max(0, settings.liveDeclaredCashUsd ?? 0);
  const empty: PortfolioState = {
    mode: "live",
    cash: declaredCash,
    totalValue: declaredCash,
    exposure: 0,
    positions: [],
    exposureByMarket: {},
    exposureByCategory: {},
    exposureByVenue: {},
    realizedPnl: 0,
    unrealizedPnl: 0,
    dailyPnl: 0,
    dailyRealizedPnl: 0,
    allTimePnl: 0,
    closedTrades: 0,
    isSample: false,
  };
  if (!wallet) return empty;

  try {
    const raw = await cached(`livepos:${wallet}`, 30_000, () =>
      fetchUserPositions(wallet),
    );
    const positions: PositionRecord[] = raw.map((p) => ({
      tokenId: p.asset,
      mode: "live",
      conditionId: p.conditionId,
      outcome: p.outcome,
      marketTitle: p.title,
      size: p.size,
      avgPrice: p.avgPrice,
      realizedPnl: 0,
      updatedAt: Date.now(),
      markPrice: p.curPrice,
      unrealizedPnl: Number((p.cashPnl ?? 0).toFixed(2)),
      value: Number((p.currentValue ?? 0).toFixed(2)),
    }));
    const exposure = positions.reduce((a, p) => a + (p.value ?? 0), 0);
    const unrealized = positions.reduce((a, p) => a + (p.unrealizedPnl ?? 0), 0);
    const exposureByMarket: Record<string, number> = {};
    for (const p of positions) {
      exposureByMarket[p.conditionId ?? p.tokenId] =
        (exposureByMarket[p.conditionId ?? p.tokenId] ?? 0) + (p.value ?? 0);
    }
    return {
      ...empty,
      totalValue: Number((exposure + declaredCash).toFixed(2)),
      exposure: Number(exposure.toFixed(2)),
      positions,
      exposureByMarket,
      unrealizedPnl: Number(unrealized.toFixed(2)),
    };
  } catch {
    return empty;
  }
}

/** persist a portfolio snapshot at most once per interval */
export async function maybeSnapshotPortfolio(
  mode: TerminalMode,
  minIntervalMs = 5 * 60_000,
): Promise<void> {
  if (mode === "demo") return; // sample data is never persisted as history
  const store = await getStore();
  const existing = await store.listPortfolioSnapshots(mode, 1);
  const last = existing[existing.length - 1];
  if (last && Date.now() - last.ts < minIntervalMs) return;
  const p = await computePortfolio(mode);
  await store.addPortfolioSnapshot({
    id: genId("psnap"),
    ts: Date.now(),
    mode,
    totalValue: p.totalValue,
    cash: p.cash,
    exposure: p.exposure,
    realizedPnl: p.realizedPnl,
    unrealizedPnl: p.unrealizedPnl,
    dailyPnl: p.dailyPnl,
    drawdown: p.maxDrawdown ?? 0,
  });
}
