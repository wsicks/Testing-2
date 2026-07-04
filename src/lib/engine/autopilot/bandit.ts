// Thompson-sampling bandit over signal strategies.
//
// Each strategy holds a Beta(α, β) posterior over its per-trade win
// probability, updated from the autopilot's REALIZED exits (never from
// hypotheticals). Entry candidates are ranked by sampled-θ × normalized
// signal score, so capital drifts toward strategies that are actually
// working while still exploring the rest. All randomness is injectable for
// deterministic tests.

import type { BanditArm } from "@/lib/types";

export interface BanditState {
  arms: Record<string, { alpha: number; beta: number; wins: number; losses: number; realizedPnlUsd: number }>;
}

export function emptyBandit(strategies: string[]): BanditState {
  const arms: BanditState["arms"] = {};
  for (const s of strategies) {
    arms[s] = { alpha: 1, beta: 1, wins: 0, losses: 0, realizedPnlUsd: 0 };
  }
  return { arms };
}

export function ensureArm(state: BanditState, strategy: string): void {
  if (!state.arms[strategy]) {
    state.arms[strategy] = { alpha: 1, beta: 1, wins: 0, losses: 0, realizedPnlUsd: 0 };
  }
}

/** record a realized outcome for a strategy */
export function updateBandit(
  state: BanditState,
  strategy: string,
  won: boolean,
  pnlUsd: number,
): BanditState {
  ensureArm(state, strategy);
  const arm = state.arms[strategy];
  if (won) {
    arm.alpha += 1;
    arm.wins += 1;
  } else {
    arm.beta += 1;
    arm.losses += 1;
  }
  arm.realizedPnlUsd = Number((arm.realizedPnlUsd + pnlUsd).toFixed(2));
  return state;
}

/**
 * Beta(α, β) sample via the ratio-of-gammas method with a simple
 * Marsaglia–Tsang gamma sampler. Deterministic under an injected PRNG.
 */
export function sampleBeta(alpha: number, beta: number, rand: () => number): number {
  const x = sampleGamma(alpha, rand);
  const y = sampleGamma(beta, rand);
  return x / (x + y);
}

function sampleGamma(shape: number, rand: () => number): number {
  if (shape < 1) {
    // Johnk boost for shape < 1
    const u = Math.max(1e-12, rand());
    return sampleGamma(shape + 1, rand) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = gaussianFrom(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(1e-12, rand());
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function gaussianFrom(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Thompson-sample every arm; returns display-ready arms sorted by sample. */
export function sampleArms(
  state: BanditState,
  rand: () => number,
): BanditArm[] {
  return Object.entries(state.arms)
    .map(([strategy, a]) => ({
      strategy,
      alpha: a.alpha,
      beta: a.beta,
      mean: a.alpha / (a.alpha + a.beta),
      sampled: sampleBeta(a.alpha, a.beta, rand),
      wins: a.wins,
      losses: a.losses,
      realizedPnlUsd: a.realizedPnlUsd,
    }))
    .sort((x, y) => (y.sampled ?? 0) - (x.sampled ?? 0));
}
