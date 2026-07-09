// Book memory — the previous order-book snapshot per token, kept in memory
// so consecutive scans can be DIFFED. One snapshot per enriched market
// (scanner fetches ~12 books/scan), hard-capped, self-pruning.
//
// The point: a single snapshot shows displayed depth; two snapshots plus the
// tape show which depth was REAL. Quotes that vanish between scans without
// prints to account for them were never available to trade against.

import type { OrderBookData } from "@/lib/types";

interface BookMemoryGlobal {
  byToken: Map<string, OrderBookData>;
}

const g = globalThis as unknown as { __eqBookMemory?: BookMemoryGlobal };

function state(): BookMemoryGlobal {
  if (!g.__eqBookMemory) g.__eqBookMemory = { byToken: new Map() };
  return g.__eqBookMemory;
}

const CAP = 200;

/** returns the PREVIOUS snapshot (if any), then remembers the new one */
export function swapBookSnapshot(tokenId: string, book: OrderBookData): OrderBookData | undefined {
  const s = state();
  const prev = s.byToken.get(tokenId);
  if (!s.byToken.has(tokenId) && s.byToken.size >= CAP) {
    // evict the stalest entry
    let oldest: string | undefined, oldestTs = Infinity;
    for (const [k, v] of s.byToken) if (v.ts < oldestTs) { oldest = k; oldestTs = v.ts; }
    if (oldest) s.byToken.delete(oldest);
  }
  s.byToken.set(tokenId, book);
  return prev;
}

/** inspect the remembered snapshot without advancing the diff baseline */
export function peekBookSnapshot(tokenId: string): OrderBookData | undefined {
  return state().byToken.get(tokenId);
}
