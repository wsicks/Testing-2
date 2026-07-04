// CLOB read-only API adapter: order books, prices, midpoints, spreads and
// price history. Docs: https://docs.polymarket.com — CLOB API.

import { CLOB_API_URL } from "../constants";
import type { OrderBookData, BookLevel, PricePoint } from "../types";
import { getJson, qs, type HttpOpts } from "./http";

interface RawBookLevel {
  price: string;
  size: string;
}

export interface RawOrderBook {
  market: string;
  asset_id: string;
  timestamp: string;
  hash?: string;
  bids: RawBookLevel[];
  asks: RawBookLevel[];
}

/** USD depth resting within `band` of the midpoint on one side of the book. */
export function depthWithinBand(
  levels: BookLevel[],
  mid: number,
  band = 0.05,
): number {
  let usd = 0;
  for (const l of levels) {
    if (Math.abs(l.price - mid) <= band) usd += l.price * l.size;
  }
  return usd;
}

export function normalizeBook(raw: RawOrderBook): OrderBookData {
  const bids = (raw.bids ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => b.price - a.price);
  const asks = (raw.asks ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const midpoint =
    bestBid !== undefined && bestAsk !== undefined
      ? (bestBid + bestAsk) / 2
      : bestBid ?? bestAsk;
  const spread =
    bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined;
  return {
    tokenId: raw.asset_id,
    bids,
    asks,
    bestBid,
    bestAsk,
    midpoint,
    spread,
    bidDepthUsd: midpoint !== undefined ? depthWithinBand(bids, midpoint) : 0,
    askDepthUsd: midpoint !== undefined ? depthWithinBand(asks, midpoint) : 0,
    ts: Number(raw.timestamp) || Date.now(),
    source: "clob",
  };
}

export async function fetchOrderBook(
  tokenId: string,
  opts: HttpOpts = {},
): Promise<OrderBookData> {
  const raw = await getJson<RawOrderBook>(
    `${CLOB_API_URL}/book` + qs({ token_id: tokenId }),
    opts,
  );
  return normalizeBook(raw);
}

export async function fetchMidpoint(
  tokenId: string,
  opts: HttpOpts = {},
): Promise<number | undefined> {
  const r = await getJson<{ mid: string }>(
    `${CLOB_API_URL}/midpoint` + qs({ token_id: tokenId }),
    opts,
  );
  const v = Number(r.mid);
  return Number.isFinite(v) ? v : undefined;
}

export async function fetchBestPrice(
  tokenId: string,
  side: "buy" | "sell",
  opts: HttpOpts = {},
): Promise<number | undefined> {
  const r = await getJson<{ price: string }>(
    `${CLOB_API_URL}/price` + qs({ token_id: tokenId, side }),
    opts,
  );
  const v = Number(r.price);
  return Number.isFinite(v) ? v : undefined;
}

export async function fetchSpread(
  tokenId: string,
  opts: HttpOpts = {},
): Promise<number | undefined> {
  const r = await getJson<{ spread: string }>(
    `${CLOB_API_URL}/spread` + qs({ token_id: tokenId }),
    opts,
  );
  const v = Number(r.spread);
  return Number.isFinite(v) ? v : undefined;
}

export type HistoryInterval = "1m" | "1w" | "1d" | "6h" | "1h" | "max";

/**
 * Price history for a CLOB token.
 * `fidelity` is the bar resolution in minutes.
 */
export async function fetchPriceHistory(
  tokenId: string,
  params: { interval?: HistoryInterval; startTs?: number; endTs?: number; fidelity?: number } = {},
  opts: HttpOpts = {},
): Promise<PricePoint[]> {
  const url =
    `${CLOB_API_URL}/prices-history` +
    qs({
      market: tokenId,
      interval: params.startTs ? undefined : params.interval ?? "1d",
      startTs: params.startTs,
      endTs: params.endTs,
      fidelity: params.fidelity ?? 30,
    });
  const r = await getJson<{ history: { t: number; p: number }[] }>(url, opts);
  return (r.history ?? [])
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p))
    .sort((a, b) => a.t - b.t);
}
