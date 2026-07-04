// Strategy 4 — Cross-market relationship scanner.
// Detects potentially related markets (same event, shared tags, shared key
// terms, similar close dates) and surfaces pricing inconsistencies for HUMAN
// review. It never assumes true arbitrage: the resolution-rules check is
// always marked unverified so the signal cannot auto-approve.

import type {
  NormalizedMarket,
  SignalContext,
  SignalResult,
  SignalStrategy,
} from "@/lib/types";
import { buildSignal, check, ramp } from "./helpers";

const STOPWORDS = new Set([
  "will", "the", "a", "an", "in", "on", "by", "of", "to", "be", "before",
  "after", "than", "win", "2025", "2026", "market", "resolve", "yes", "no",
  "or", "and", "at", "for", "what", "who", "how", "many",
]);

export function keyTerms(question: string): Set<string> {
  return new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export function termOverlap(a: string, b: string): number {
  const ta = keyTerms(a);
  const tb = keyTerms(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  ta.forEach((t) => {
    if (tb.has(t)) common += 1;
  });
  return common / Math.min(ta.size, tb.size);
}

export function findRelated(
  anchor: NormalizedMarket,
  universe: NormalizedMarket[],
): { market: NormalizedMarket; basis: string; strength: number }[] {
  const out: { market: NormalizedMarket; basis: string; strength: number }[] = [];
  for (const m of universe) {
    if (m.conditionId === anchor.conditionId) continue;
    if (anchor.eventSlug && m.eventSlug === anchor.eventSlug) {
      out.push({ market: m, basis: "same_event", strength: 1 });
      continue;
    }
    const sharedTags = m.tags.filter(
      (t) => anchor.tags.includes(t) && t.toLowerCase() !== "sports" && t.toLowerCase() !== "politics",
    );
    const overlap = termOverlap(anchor.question, m.question);
    const sameWindow =
      anchor.endDate && m.endDate
        ? Math.abs(new Date(anchor.endDate).getTime() - new Date(m.endDate).getTime()) <
          72 * 3_600_000
        : false;
    if (overlap >= 0.5 && (sharedTags.length > 0 || sameWindow)) {
      out.push({
        market: m,
        basis: sharedTags.length ? `shared_terms+tags(${sharedTags[0]})` : "shared_terms+window",
        strength: overlap,
      });
    }
  }
  return out.sort((a, b) => b.strength - a.strength).slice(0, 6);
}

export const crossMarketSignal: SignalStrategy = {
  id: "cross_market",
  label: "Cross-Market Relations",
  description:
    "Surfaces potentially related markets and pricing inconsistencies for human review. Resolution rules are never assumed equivalent.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, relatedMarkets, settings, now } = ctx;
    if (!relatedMarkets?.length) return null;
    const related = findRelated(market, relatedMarkets);
    if (related.length === 0) return null;

    // Same-event group: for negRisk events the YES prices across sibling
    // markets should sum to ≈ 1. A large deviation is an inconsistency.
    const sameEvent = related.filter((r) => r.basis === "same_event");
    let groupSum: number | undefined;
    if (market.negRisk && sameEvent.length >= 1) {
      groupSum =
        (market.yesPrice ?? 0) +
        sameEvent.reduce((a, r) => a + (r.market.yesPrice ?? 0), 0);
    }
    const groupDeviation =
      groupSum !== undefined ? Math.abs(groupSum - 1) : undefined;
    const costBuffer =
      settings.feeRateBps / 10_000 + settings.slippageBps / 10_000 + 0.02;

    const inconsistent =
      groupDeviation !== undefined && groupDeviation > costBuffer;

    if (!inconsistent && related.every((r) => r.strength < 0.6)) return null;

    const checks = [
      check(
        "related_markets_found",
        true,
        related
          .map((r) => `${r.market.question.slice(0, 48)} [${r.basis}]`)
          .join("; "),
        related.length,
      ),
    ];
    if (groupDeviation !== undefined) {
      checks.push(
        check(
          "group_price_consistency",
          !inconsistent,
          `Same-event YES prices sum to ${((groupSum ?? 0) * 100).toFixed(1)}c (deviation ${(groupDeviation * 100).toFixed(1)}c vs buffer ${(costBuffer * 100).toFixed(1)}c)`,
          groupDeviation,
          costBuffer,
        ),
      );
    }
    checks.push(
      check(
        "resolution_rules_verified",
        false,
        "Resolution rules across related markets have NOT been verified as equivalent — human review required before any action.",
      ),
      check(
        "liquidity_floor",
        market.liquidity >= settings.minLiquidityUsd,
        `Anchor liquidity $${Math.round(market.liquidity).toLocaleString()} vs min $${settings.minLiquidityUsd.toLocaleString()}`,
        market.liquidity,
        settings.minLiquidityUsd,
      ),
    );

    const score = inconsistent
      ? 45 + 55 * ramp((groupDeviation ?? 0) - costBuffer, 0, 0.08)
      : 25 + 25 * (related[0]?.strength ?? 0);

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: "NEUTRAL",
      score,
      summary: inconsistent
        ? `Same-event YES sum ${((groupSum ?? 0) * 100).toFixed(1)}c deviates ${((groupDeviation ?? 0) * 100).toFixed(1)}c — inconsistency flagged for review`
        : `${related.length} related market(s) detected (${related[0].basis}) — price comparison for review`,
      checks,
      now,
      ttlMs: 20 * 60_000,
      meta: {
        related: related.map((r) => ({
          conditionId: r.market.conditionId,
          question: r.market.question,
          basis: r.basis,
          strength: Number(r.strength.toFixed(2)),
          yesPrice: r.market.yesPrice,
        })),
        groupSum,
        groupDeviation,
        costBuffer,
      },
    });
  },
};
