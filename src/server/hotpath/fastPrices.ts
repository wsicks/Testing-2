// Fast-lane price sampler — the faster-than-scan price path (ERRORLOG E-038).
//
// The market registry refreshes on the ~30s scan cadence, so a 5-second
// outcome bucket could never capture an honestly-fresh price — every b5s
// cell was MISSED and the prosecutor's latency test ran blind. This module
// watches a SMALL set of tokens (only those with outstanding short-bucket
// timers) and samples their midpoints every 5s through the CLOB's batch
// midpoint endpoint — ONE request per tick for the whole watch set, shape
// verified live before this adapter was written.
//
// Discipline: the sampler runs only while the watch set is non-empty, each
// watch expires after WATCH_MS (short buckets are done by then), the set is
// hard-capped, and failures degrade to "no fresh price" (captures fall back
// to MISSED — never to a stale or invented number).

import { fetchMidpoints } from "@/lib/polymarket/clob";
import { logError } from "../errorLog";

interface Watch {
  tokenId: string;
  expiresAt: number;
}

interface FastPrice {
  mid: number;
  fetchedAt: number;
}

interface FastGlobal {
  /** conditionId → watch */
  watches: Map<string, Watch>;
  /** conditionId → freshest sampled price */
  prices: Map<string, FastPrice>;
  timer: ReturnType<typeof setInterval> | null;
}

const g = globalThis as unknown as { __eqFastPrices?: FastGlobal };

function state(): FastGlobal {
  if (!g.__eqFastPrices) {
    g.__eqFastPrices = { watches: new Map(), prices: new Map(), timer: null };
  }
  return g.__eqFastPrices;
}

const SAMPLE_MS = 5_000;
/** watch long enough to cover b5s + b30s captures with slack */
const WATCH_MS = 90_000;
const MAX_WATCHES = 40;

async function sample(): Promise<void> {
  const s = state();
  const now = Date.now();
  for (const [cid, w] of s.watches) {
    if (now > w.expiresAt) {
      s.watches.delete(cid);
      s.prices.delete(cid);
    }
  }
  if (s.watches.size === 0) {
    if (s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
    return;
  }
  const entries = [...s.watches.entries()];
  const byToken = new Map(entries.map(([cid, w]) => [w.tokenId, cid]));
  try {
    const mids = await fetchMidpoints([...byToken.keys()], { timeoutMs: 4_000 });
    const at = Date.now();
    for (const [tokenId, mid] of mids) {
      const cid = byToken.get(tokenId);
      if (cid) s.prices.set(cid, { mid, fetchedAt: at });
    }
  } catch (err) {
    // degrade to "no fresh price" — the outcome tracker records MISSED,
    // never a stale substitute
    logError("fastprices:sample", err);
  }
}

/**
 * Watch a market's YES token for the short-bucket window. Called by the
 * outcome tracker when it creates 5s/30s timers.
 */
export function watchFastPrice(conditionId: string, tokenId: string | undefined): void {
  if (!tokenId) return;
  const s = state();
  if (s.watches.size >= MAX_WATCHES && !s.watches.has(conditionId)) return; // bounded
  s.watches.set(conditionId, { tokenId, expiresAt: Date.now() + WATCH_MS });
  if (!s.timer) {
    s.timer = setInterval(() => void sample(), SAMPLE_MS);
    if (typeof s.timer === "object" && "unref" in s.timer) s.timer.unref();
    void sample(); // first sample immediately — the 5s bucket can't wait
  }
}

/** freshest fast-lane price for a market, if one was sampled */
export function fastPriceFor(conditionId: string): FastPrice | undefined {
  return state().prices.get(conditionId);
}
