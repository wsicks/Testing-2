import { genId } from "@/lib/utils";
import type {
  NormalizedMarket,
  SignalCheckResult,
  SignalDirection,
  SignalResult,
} from "@/lib/types";
import { clamp } from "@/lib/format";

export function check(
  name: string,
  passed: boolean,
  detail: string,
  value?: number,
  threshold?: number,
): SignalCheckResult {
  return { name, passed, detail, value, threshold };
}

export interface BuildSignalArgs {
  strategy: string;
  strategyLabel: string;
  market: NormalizedMarket;
  direction: SignalDirection;
  score: number;
  summary: string;
  checks: SignalCheckResult[];
  now: number;
  ttlMs?: number;
  meta?: Record<string, unknown>;
}

export function buildSignal(args: BuildSignalArgs): SignalResult {
  const blockers = args.checks.filter((c) => !c.passed);
  return {
    id: genId("sig"),
    strategy: args.strategy,
    strategyLabel: args.strategyLabel,
    conditionId: args.market.conditionId,
    tokenId: args.market.yesTokenId,
    marketQuestion: args.market.question,
    category: args.market.category,
    direction: args.direction,
    score: Math.round(clamp(args.score, 0, 100)),
    status: blockers.length === 0 ? "proposed" : "rejected",
    summary: args.summary,
    checks: args.checks,
    createdAt: args.now,
    expiresAt: args.now + (args.ttlMs ?? 15 * 60_000),
    meta: args.meta,
  };
}

/** linear ramp: 0 at `worst`, 1 at `best` (works in either direction) */
export function ramp(value: number, worst: number, best: number): number {
  if (worst === best) return value >= best ? 1 : 0;
  return clamp((value - worst) / (best - worst), 0, 1);
}

/** std-dev of consecutive diffs of a price series */
export function diffVolatility(prices: number[]): number {
  if (prices.length < 3) return 0;
  const diffs: number[] = [];
  for (let i = 1; i < prices.length; i++) diffs.push(prices[i] - prices[i - 1]);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const varc =
    diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, diffs.length - 1);
  return Math.sqrt(varc);
}
