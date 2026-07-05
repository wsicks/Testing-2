// Polymarket Data-API client for Wallet Radar.
//
// Endpoint shapes verified live (2026-07): /trades, /positions, /holders,
// /activity, /value. All data here is PUBLIC on-chain trading activity
// exposed by Polymarket's own API — wallet addresses and the pseudonym the
// venue itself displays. We never infer real-world identity, never fetch
// anything private, and rate-limit ourselves conservatively.
//
// The old leaderboard API (lb-api.polymarket.com) returns 404 on every known
// route; discovery therefore uses large recent trades + top holders instead.

import { DATA_API_URL } from "@/lib/constants";
import { getJson, qs, type HttpOpts } from "@/lib/polymarket/http";
import type { WalletTradeLite } from "./repo";

export interface DataApiTrade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number; // epoch SECONDS
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  pseudonym?: string;
  transactionHash?: string;
}

export interface DataApiPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  oppositeAsset?: string;
  endDate?: string;
  negativeRisk?: boolean;
}

export interface DataApiHolder {
  proxyWallet: string;
  pseudonym?: string;
  name?: string;
  amount: number;
  outcomeIndex: number;
  displayUsernamePublic?: boolean;
}

/** recent large trades across the venue — discovery input */
export async function fetchLargeTrades(
  minCashUsd: number,
  limit = 100,
  opts: HttpOpts = {},
): Promise<DataApiTrade[]> {
  const url = `${DATA_API_URL}/trades${qs({
    filterType: "CASH",
    filterAmount: minCashUsd,
    limit,
  })}`;
  return getJson<DataApiTrade[]>(url, opts);
}

/** one wallet's recent trades (public tape) */
export async function fetchWalletTrades(
  wallet: string,
  limit = 200,
  opts: HttpOpts = {},
): Promise<DataApiTrade[]> {
  const url = `${DATA_API_URL}/trades${qs({ user: wallet, limit })}`;
  return getJson<DataApiTrade[]>(url, opts);
}

/** one wallet's positions — includes settled rows (curPrice 0/1, redeemable) */
export async function fetchWalletPositions(
  wallet: string,
  limit = 500,
  opts: HttpOpts = {},
): Promise<DataApiPosition[]> {
  const url = `${DATA_API_URL}/positions${qs({
    user: wallet,
    limit,
    sizeThreshold: 0.1,
  })}`;
  return getJson<DataApiPosition[]>(url, opts);
}

/** top holders per outcome token of one market */
export async function fetchHolders(
  conditionId: string,
  limit = 10,
  opts: HttpOpts = {},
): Promise<{ token: string; holders: DataApiHolder[] }[]> {
  const url = `${DATA_API_URL}/holders${qs({ market: conditionId, limit })}`;
  return getJson<{ token: string; holders: DataApiHolder[] }[]>(url, opts);
}

export function toTradeLite(t: DataApiTrade): WalletTradeLite {
  return {
    side: t.side,
    conditionId: t.conditionId,
    asset: t.asset,
    outcome: t.outcome,
    outcomeIndex: t.outcomeIndex,
    size: t.size,
    price: t.price,
    ts: t.timestamp * 1000,
    title: t.title,
    eventSlug: t.eventSlug,
  };
}

/** tiny sequential throttle so wallet refresh bursts stay polite */
export async function politeDelay(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
