// Monte Carlo position-sizing simulator.
// Deterministic under a fixed seed. Outputs are RISK DISPLAYS — distributions
// of what could happen under the stated assumptions — never profit claims.

import { mulberry32 } from "@/lib/rng";
import type { MonteCarloConfig, MonteCarloResult } from "@/lib/types";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx];
}

export function runMonteCarlo(config: MonteCarloConfig): MonteCarloResult {
  const {
    winRate,
    avgWinPct,
    avgLossPct,
    positionPct,
    numTrades,
    numPaths,
    initialCapital,
  } = config;
  const rand = mulberry32(config.seed ?? 1337);

  const finals: number[] = [];
  const maxDds: number[] = [];
  let ruined = 0;
  // store every path's equity at checkpoints to build percentile bands.
  // ceil, not floor: floor(100/60)=1 would cap the band at trade 60 and
  // silently drop the last 40% of the horizon from the fan chart
  const checkpoints = Math.min(numTrades, 60);
  const step = Math.max(1, Math.ceil(numTrades / checkpoints));
  const bandSamples: number[][] = Array.from({ length: checkpoints + 1 }, () => []);

  for (let path = 0; path < numPaths; path++) {
    let equity = initialCapital;
    let peak = equity;
    let maxDd = 0;
    let isRuined = false;
    let cp = 0;
    bandSamples[0].push(1);
    for (let t = 1; t <= numTrades; t++) {
      const stake = equity * (positionPct / 100);
      const win = rand() < winRate;
      equity += win ? stake * (avgWinPct / 100) : -stake * (avgLossPct / 100);
      if (equity <= initialCapital * 0.1) {
        // ruin defined as losing 90% of starting capital
        isRuined = true;
        equity = Math.max(equity, 0);
      }
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak : 0);
      if (t % step === 0 && cp < checkpoints) {
        cp += 1;
        bandSamples[cp].push(equity / initialCapital);
      }
    }
    finals.push(equity / initialCapital - 1); // return multiple
    maxDds.push(maxDd);
    if (isRuined) ruined += 1;
  }

  finals.sort((a, b) => a - b);
  maxDds.sort((a, b) => a - b);

  const paths = bandSamples
    // with step=ceil the tail checkpoint slots can be unused — an empty
    // slot must be dropped, not rendered as a NaN band point
    .filter((samples) => samples.length > 0)
    .map((samples, i) => {
      const s = [...samples].sort((a, b) => a - b);
      return {
        t: Math.min(numTrades, i * step),
        p5: percentile(s, 5),
        p25: percentile(s, 25),
        p50: percentile(s, 50),
        p75: percentile(s, 75),
        p95: percentile(s, 95),
      };
    });

  // histogram of final returns
  const lo = finals[0] ?? 0;
  const hi = finals[finals.length - 1] ?? 0;
  const buckets = 21;
  const width = (hi - lo) / buckets || 1;
  const histogram = Array.from({ length: buckets }, (_, i) => ({
    bucket: lo + (i + 0.5) * width,
    count: 0,
  }));
  for (const f of finals) {
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((f - lo) / width)));
    histogram[i].count += 1;
  }

  const worst5 = finals.slice(0, Math.max(1, Math.floor(finals.length * 0.05)));

  return {
    config,
    finalEquityPercentiles: {
      p5: percentile(finals, 5),
      p25: percentile(finals, 25),
      p50: percentile(finals, 50),
      p75: percentile(finals, 75),
      p95: percentile(finals, 95),
    },
    maxDrawdownPercentiles: {
      p5: percentile(maxDds, 5),
      p50: percentile(maxDds, 50),
      p95: percentile(maxDds, 95),
    },
    riskOfRuin: ruined / numPaths,
    worst5PctOutcome: worst5.reduce((a, b) => a + b, 0) / worst5.length,
    expectedFinal: finals.reduce((a, b) => a + b, 0) / finals.length,
    paths,
    histogram,
    isRiskDisplay: true,
  };
}
