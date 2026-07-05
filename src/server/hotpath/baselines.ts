// Rolling per-market microstructure baselines — spread and liquidity EMAs
// fed by every scan pass. Pure in-memory hot-path state: reads are O(1) map
// lookups, writes happen once per scan for the whole universe. Baselines
// rebuild from live data after a restart (≈10 minutes of scans); consumers
// gate on `samples` so a cold store self-rejects instead of guessing.

export interface MarketBaseline {
  /** EMA of the quoted spread (α=0.05 ≈ 20-scan half-life at 30s cadence) */
  spreadEma: number;
  /** EMA of quoted liquidity (USD) */
  liquidityEma: number;
  samples: number;
  updatedAt: number;
}

interface BaselineGlobal {
  byMarket: Map<string, MarketBaseline>;
}

const g = globalThis as unknown as { __eqBaselines?: BaselineGlobal };

function state(): BaselineGlobal {
  if (!g.__eqBaselines) g.__eqBaselines = { byMarket: new Map() };
  return g.__eqBaselines;
}

const ALPHA = 0.05;
const CAP = 6_000; // universe is ~2.2k; hard cap against unbounded growth

export function updateBaselines(
  rows: { conditionId: string; spread?: number; liquidity: number }[],
  now: number,
): void {
  const s = state();
  for (const m of rows) {
    if (m.spread === undefined) continue;
    const cur = s.byMarket.get(m.conditionId);
    if (!cur) {
      if (s.byMarket.size >= CAP) continue;
      s.byMarket.set(m.conditionId, {
        spreadEma: m.spread,
        liquidityEma: m.liquidity,
        samples: 1,
        updatedAt: now,
      });
    } else {
      cur.spreadEma += ALPHA * (m.spread - cur.spreadEma);
      cur.liquidityEma += ALPHA * (m.liquidity - cur.liquidityEma);
      cur.samples += 1;
      cur.updatedAt = now;
    }
  }
  // drop baselines for markets gone from the universe for >24h
  const cutoff = now - 24 * 3_600_000;
  for (const [id, b] of s.byMarket) if (b.updatedAt < cutoff) s.byMarket.delete(id);
}

export function getBaseline(conditionId: string): MarketBaseline | undefined {
  return state().byMarket.get(conditionId);
}

export function baselineInfo(): { markets: number } {
  return { markets: state().byMarket.size };
}
