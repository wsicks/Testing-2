// In-memory market registry — the hot-path source of market state.
//
// Rebuilt from each Gamma refresh; O(1) lookups by conditionId, tokenId and
// slug; precomputed tokenId→price map. Reads never touch the network or the
// store. `updatedAt` lets consumers reason about freshness explicitly instead
// of silently serving stale state.

import type { NormalizedMarket } from "@/lib/types";
import { incr, measureSync } from "../perf";

interface RegistryGlobal {
  byCondition: Map<string, NormalizedMarket>;
  byToken: Map<string, NormalizedMarket>;
  bySlug: Map<string, NormalizedMarket>;
  prices: Map<string, number>;
  updatedAt: number;
  size: number;
}

const g = globalThis as unknown as { __pqRegistry?: RegistryGlobal };

function state(): RegistryGlobal {
  if (!g.__pqRegistry) {
    g.__pqRegistry = {
      byCondition: new Map(),
      byToken: new Map(),
      bySlug: new Map(),
      prices: new Map(),
      updatedAt: 0,
      size: 0,
    };
  }
  return g.__pqRegistry;
}

export function updateRegistry(markets: NormalizedMarket[]): void {
  measureSync("hot.registry_ingest", () => {
    const s = state();
    s.byCondition = new Map();
    s.byToken = new Map();
    s.bySlug = new Map();
    s.prices = new Map();
    for (const m of markets) {
      s.byCondition.set(m.conditionId, m);
      if (m.slug) s.bySlug.set(m.slug, m);
      for (const o of m.outcomes) {
        if (!o.tokenId) continue;
        s.byToken.set(o.tokenId, m);
        if (o.price !== undefined) s.prices.set(o.tokenId, o.price);
      }
    }
    s.updatedAt = Date.now();
    s.size = markets.length;
  });
  incr("registry.updates");
}

/** apply a single market update in place (per-market delta, no full rebuild) */
export function upsertRegistryMarket(m: NormalizedMarket): void {
  const s = state();
  s.byCondition.set(m.conditionId, m);
  if (m.slug) s.bySlug.set(m.slug, m);
  for (const o of m.outcomes) {
    if (!o.tokenId) continue;
    s.byToken.set(o.tokenId, m);
    if (o.price !== undefined) s.prices.set(o.tokenId, o.price);
  }
  s.updatedAt = Date.now();
}

export function regByCondition(conditionId: string): NormalizedMarket | undefined {
  return state().byCondition.get(conditionId);
}

export function regByToken(tokenId: string): NormalizedMarket | undefined {
  return state().byToken.get(tokenId);
}

export function regPrices(): Map<string, number> {
  return state().prices;
}

export function regInfo(): { size: number; updatedAt: number; ageMs: number } {
  const s = state();
  return { size: s.size, updatedAt: s.updatedAt, ageMs: Date.now() - s.updatedAt };
}
