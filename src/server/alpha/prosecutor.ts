// ALPHA PROSECUTOR — tries to destroy every feature before it can be
// promoted. Each test is evidence-based and returns WHY it passed or failed.
// A feature that survives every test still needs an explicit human approval
// before promotion; the prosecutor can only block, never promote.

import type {
  AlphaFeature,
  FeatureEvidence,
  ProsecutorTest,
  ProsecutorVerdict,
  SourceRecord,
} from "@/lib/alpha/types";

const T = (
  name: string,
  passed: boolean,
  evidence: string,
  value?: number,
  threshold?: number,
): ProsecutorTest => ({ name, passed, evidence, value, threshold });

export interface ProsecutorInputs {
  feature: AlphaFeature;
  evidence: FeatureEvidence;
  /** evidence over the most recent window only (post-awareness test) */
  recentEvidence: FeatureEvidence;
  sources: SourceRecord[];
  slippageBps: number;
  maxSpread: number;
}

export function prosecute(x: ProsecutorInputs): ProsecutorVerdict {
  const { feature, evidence: ev, recentEvidence: rec } = x;
  const oneH = ev.curve.find((c) => c.bucket === "b1h");
  const fiveS = ev.curve.find((c) => c.bucket === "b5s");
  const recent1h = rec.curve.find((c) => c.bucket === "b1h");
  const edge = oneH?.avgDrift ?? 0;
  const friction = ev.avgSpread / 2 + x.slippageBps / 10_000;

  const tests: ProsecutorTest[] = [
    T(
      "sample_size",
      ev.outcomes >= 100 && ev.tradableOutcomes >= 30,
      `${ev.outcomes} logged signals (min 100), ${ev.tradableOutcomes} tradable at signal time (min 30)`,
      ev.outcomes,
      100,
    ),
    T(
      "net_expectancy_after_costs",
      (oneH?.n ?? 0) >= 30 && edge - friction > 0,
      `avg 1h drift ${(edge * 100).toFixed(2)}c vs friction ${(friction * 100).toFixed(2)}c (half-spread + ${x.slippageBps}bps slippage) over ${oneH?.n ?? 0} captures`,
      edge - friction,
      0,
    ),
    T(
      "spread_survival",
      edge > ev.avgSpread / 2,
      `edge ${(edge * 100).toFixed(2)}c vs avg half-spread ${((ev.avgSpread / 2) * 100).toFixed(2)}c`,
      edge,
      ev.avgSpread / 2,
    ),
    T(
      "slippage_survival",
      edge - friction - 0.005 > 0,
      `edge holds after an extra 50bps adverse-slippage stress`,
      edge - friction - 0.005,
      0,
    ),
    T(
      "latency_survival",
      !(fiveS && fiveS.n >= 10 && edge > 0 && fiveS.avgDrift / edge > 0.8),
      fiveS && fiveS.n >= 10
        ? `${((Math.max(0, fiveS.avgDrift) / Math.max(1e-6, edge)) * 100).toFixed(0)}% of the 1h edge is consumed within 5s (fail > 80%)`
        : "insufficient 5s captures to prove latency dependence — not held against the feature",
    ),
    T(
      "out_of_sample_persistence",
      (recent1h?.n ?? 0) >= 10 ? (recent1h?.avgDrift ?? 0) > 0 : false,
      (recent1h?.n ?? 0) >= 10
        ? `recent-window avg 1h drift ${((recent1h?.avgDrift ?? 0) * 100).toFixed(2)}c over ${recent1h?.n} captures`
        : `only ${recent1h?.n ?? 0} recent captures — the edge has not yet survived a fresh window`,
      recent1h?.avgDrift,
      0,
    ),
    T(
      "lucky_trade_concentration",
      ev.luckyConcentration <= 0.25,
      `best single outcome explains ${(ev.luckyConcentration * 100).toFixed(0)}% of positive drift (max 25%)`,
      ev.luckyConcentration,
      0.25,
    ),
    T(
      "liquidity_dependence",
      ev.outcomes === 0 || ev.tradableOutcomes / ev.outcomes >= 0.5,
      `${ev.outcomes ? Math.round((ev.tradableOutcomes / ev.outcomes) * 100) : 0}% of signals were tradable at the displayed price (min 50%)`,
    ),
    T(
      "stale_price_dependence",
      ev.staleShare <= 0.2,
      `${(ev.staleShare * 100).toFixed(0)}% of signals fired on market data older than 60s (max 20%)`,
      ev.staleShare,
      0.2,
    ),
    T(
      "forward_mode_spread",
      ev.distinctDays >= 7 && ev.distinctMarkets >= 10,
      `evidence spans ${ev.distinctDays} distinct day(s) and ${ev.distinctMarkets} distinct market(s) (min 7 days / 10 markets — one lucky burst is not a feature)`,
    ),
    T(
      "drawdown_control",
      ev.maxAdverseRun <= 8,
      `longest adverse 1h-drift run: ${ev.maxAdverseRun} consecutive signals (max 8)`,
      ev.maxAdverseRun,
      8,
    ),
    ...termsTests(feature, x.sources),
  ];

  const passed = tests.every((t) => t.passed);
  return {
    featureId: feature.id,
    ranAt: Date.now(),
    tests,
    passed,
    summary: passed
      ? `survived all ${tests.length} prosecution tests — eligible for HUMAN promotion review`
      : `failed ${tests.filter((t) => !t.passed).length}/${tests.length} tests: ${tests
          .filter((t) => !t.passed)
          .map((t) => t.name)
          .join(", ")}`,
  };
}

function termsTests(feature: AlphaFeature, sources: SourceRecord[]): ProsecutorTest[] {
  const rows = feature.dataSources.map((id) => sources.find((s) => s.sourceId === id));
  const missing = feature.dataSources.filter((_, i) => !rows[i]);
  const bad = rows.filter(
    (s): s is SourceRecord =>
      !!s && (s.status === "banned" || s.status === "manual_review" || s.status === "unavailable"),
  );
  const degraded = rows.filter((s): s is SourceRecord => !!s && s.status === "degraded");
  return [
    T(
      "source_terms_review",
      missing.length === 0 && bad.length === 0,
      missing.length > 0
        ? `data source(s) not in registry: ${missing.join(", ")}`
        : bad.length > 0
          ? `source(s) not cleared for use: ${bad.map((s) => `${s.sourceId} (${s.status})`).join(", ")}`
          : `all ${rows.length} source(s) registered and cleared`,
    ),
    T(
      "source_reliability",
      degraded.length === 0,
      degraded.length > 0
        ? `degraded source(s): ${degraded.map((s) => s.sourceId).join(", ")}`
        : "no degraded sources",
    ),
  ];
}
