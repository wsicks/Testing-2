// Data API adapter: public trade tape, user positions/value, and holders.
// Docs: https://docs.polymarket.com — Data API.

import { DATA_API_URL } from "../constants";
import type { RecentTrade } from "../types";
import { getJson, qs, type HttpOpts } from "./http";

export interface DataApiTradeRaw {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title?: string;
  outcome?: string;
}

export async function fetchRecentTrades(
  conditionId: string,
  limit = 30,
  opts: HttpOpts = {},
): Promise<RecentTrade[]> {
  const raw = await getJson<DataApiTradeRaw[]>(
    `${DATA_API_URL}/trades` + qs({ market: conditionId, limit }),
    opts,
  );
  return (raw ?? []).map((t) => ({
    side: t.side,
    price: t.price,
    size: t.size,
    ts: t.timestamp * 1000,
    outcome: t.outcome,
  }));
}

export interface UserPositionRaw {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  title?: string;
  outcome?: string;
  slug?: string;
  endDate?: string;
}

/** Read-only on-chain position analytics for any wallet (public data). */
export async function fetchUserPositions(
  address: string,
  opts: HttpOpts = {},
): Promise<UserPositionRaw[]> {
  return getJson<UserPositionRaw[]>(
    `${DATA_API_URL}/positions` + qs({ user: address, sizeThreshold: 0.1, limit: 100 }),
    opts,
  );
}

export async function fetchUserValue(
  address: string,
  opts: HttpOpts = {},
): Promise<number | undefined> {
  const r = await getJson<{ user: string; value: number }[]>(
    `${DATA_API_URL}/value` + qs({ user: address }),
    opts,
  );
  const v = r?.[0]?.value;
  return Number.isFinite(v) ? v : undefined;
}

export interface HolderRaw {
  proxyWallet: string;
  amount: number;
  outcomeIndex: number;
  name?: string;
}

export async function fetchHolders(
  conditionId: string,
  limit = 10,
  opts: HttpOpts = {},
): Promise<{ token: string; holders: HolderRaw[] }[]> {
  const r = await getJson<{ token: string; holders: HolderRaw[] }[]>(
    `${DATA_API_URL}/holders` + qs({ market: conditionId, limit }),
    opts,
  );
  return r ?? [];
}
