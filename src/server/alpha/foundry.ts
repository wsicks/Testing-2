// ALPHA FOUNDRY — the continuous research lifecycle.
//
// idea → data_connected → backtesting → paper_testing → shadow_live →
// promoted → degraded → retired, with `rejected` reachable from any stage.
// Promotion is double-gated: the Alpha Prosecutor must pass on evidence AND
// a human must approve. Decay monitoring can demote a promoted feature
// automatically; nothing can promote automatically.
//
// The registry of features is seeded with every Feature Forge idea from the
// spec at its HONEST current status: strategies that already run in this app
// are shadow_live or paper_testing; everything not yet built is an idea with
// its thesis and kill criteria recorded — visible on the dashboard, not
// faked. No seed is ever "promoted": that requires a real human approval.

import type {
  AlphaFeature,
  AlphaFeatureStatus,
  FeatureEvidence,
  ProsecutorVerdict,
  ResearchIdea,
  SourceRecord,
} from "@/lib/alpha/types";
import {
  alphaScore,
  decayVerdict,
  isGraveyard,
  summarizeEvidence,
} from "@/lib/alpha/score";
import { seedSourceRecords } from "@/lib/alpha/sources.seed";
import { genId } from "@/lib/utils";
import { audit } from "../audit";
import { logError } from "../errorLog";
import { getStore } from "../store";
import { allOutcomes } from "./outcomes";
import {
  getLastRuns,
  listFeatures,
  listIdeas,
  listSources,
  patchLastRuns,
  saveFeatures,
  saveIdeas,
  saveSources,
  upsertFeature,
} from "./repo";
import { prosecute } from "./prosecutor";
import { refreshDisclosures } from "./disclosures";
import { discoverWallets, refreshWalletIntel, rescoreTrackedWallets } from "./walletRadar";
import { getMarkets } from "../marketData";

// ── Feature seeds ────────────────────────────────────────────────────────────

interface FeatureSeed {
  id: string;
  name: string;
  thesis: string;
  whyMissed?: string;
  dataSources: string[];
  categoryScope: string[];
  status: AlphaFeatureStatus;
  killCriteria: string;
}

const FEATURE_SEEDS: FeatureSeed[] = [
  // live strategies (status reflects real state in this app). NOTHING seeds
  // as "promoted": promotion is prosecutor-pass + a real human approval, and
  // synthesizing that at seed time would be exactly the fake authority this
  // system exists to prevent. Until a human promotes them on /foundry,
  // autopilot LIVE routing is closed for every strategy (paper unaffected).
  { id: "liquidity_spread", name: "Liquidity/Spread Screen", thesis: "Tradability screen: tight, deep books are a precondition for every other edge.", dataSources: ["polymarket_gamma", "polymarket_clob"], categoryScope: ["all"], status: "shadow_live", killCriteria: "spread/depth data becomes unreliable" },
  { id: "price_movement", name: "Momentum / Mean-Reversion Screen", thesis: "Large day moves with volume support continue more often than they revert within hours.", dataSources: ["polymarket_gamma"], categoryScope: ["all"], status: "shadow_live", killCriteria: "rolling 1h post-signal drift ≤ 0 over 30 signals" },
  { id: "complement_check", name: "Complement Probability Check", thesis: "YES+NO should sum to ~1 after costs; deviations flag data or pricing faults.", dataSources: ["polymarket_gamma"], categoryScope: ["all"], status: "shadow_live", killCriteria: "n/a — informational integrity check" },
  { id: "cross_market", name: "Same-Event Consistency", thesis: "Mutually-exclusive outcome sets that sum far from 1 imply mispricing somewhere in the set.", dataSources: ["polymarket_gamma"], categoryScope: ["all"], status: "shadow_live", killCriteria: "n/a — always requires human rule review" },
  { id: "closing_soon", name: "Closing-Window Screen", thesis: "Uncertainty near close with clear rules is where repricing debt concentrates.", dataSources: ["polymarket_gamma"], categoryScope: ["all"], status: "shadow_live", killCriteria: "n/a — informational screen" },
  { id: "dislocation", name: "Kalman Fair-Value Dislocation", thesis: "Short-horizon price dislocations vs a Kalman fair value revert after noise.", dataSources: ["polymarket_clob"], categoryScope: ["all"], status: "shadow_live", killCriteria: "rolling 1h drift ≤ 0 over 30 signals, or decay verdict" },
  { id: "microstructure", name: "Micro-price / Book Imbalance", thesis: "Stoikov micro-price and one-sided tape lead the mid over minutes.", dataSources: ["polymarket_clob"], categoryScope: ["all"], status: "shadow_live", killCriteria: "decay verdict or tradability < 50%" },
  { id: "reference_price", name: "Reference Price Gap (crypto)", thesis: "Walk-model probability from Coinbase spot+vol vs market implied — informational gauge.", dataSources: ["coinbase_public"], categoryScope: ["crypto"], status: "shadow_live", killCriteria: "n/a — model assumptions always require review" },
  { id: "venue_divergence", name: "Cross-Venue Dislocation", thesis: "Rule-comparable Polymarket/Kalshi pairs that disagree in price contain information one side hasn't priced.", dataSources: ["polymarket_gamma", "kalshi_public"], categoryScope: ["all"], status: "shadow_live", killCriteria: "rule-equivalence checks prove unreliable (conflict rate > 20%)" },
  { id: "ecl", name: "Entropy Collapse Lag", thesis: "The source of truth collapses uncertainty before the order book reprices; the lag is tradable after full friction.", whyMissed: "Requires fresh reference data, honest friction accounting and touch/terminal contract discrimination — most tooling has none of these.", dataSources: ["coinbase_public", "kalshi_public"], categoryScope: ["crypto"], status: "paper_testing", killCriteria: "1h drift after costs ≤ 0 over 50 qualified signals; or source freshness cannot be sustained" },
  { id: "wallet_shadow", name: "Smart Wallet Shadow", thesis: "Wallets with persistent category-specific skill enter before broad repricing; following is profitable only while entry drift < 2c and forward evidence stays positive.", whyMissed: "Copiers chase globally-famous wallets without category skill, forward evidence or drift limits.", dataSources: ["polymarket_data"], categoryScope: ["all"], status: "paper_testing", killCriteria: "avg forward drift after detection ≤ 0 over 30 tracked entries; or crowding kills copyable edge" },
  { id: "wallet_fade", name: "Smart Wallet Fade / Exit Warning", thesis: "Reliably-wrong wallets and crowd-chased entries mean-revert; skilled-wallet exits warn before repricing.", dataSources: ["polymarket_data"], categoryScope: ["all"], status: "paper_testing", killCriteria: "fade drift ≤ 0 over 30 signals" },
  { id: "deadline_curvature", name: "Deadline Curvature", thesis: "Terminal threshold markets must reprice nonlinearly as τ→0; books that decay linearly lag the model curve.", dataSources: ["coinbase_public"], categoryScope: ["crypto"], status: "paper_testing", killCriteria: "model-market gap shows no forward drift over 50 observations" },
  { id: "favorite_convergence", name: "Favorite Convergence", thesis: "Heavy favorites (85–97c) near resolution drift toward 1 more often than price implies (favorite–longshot bias, confirmed only by OUR drift-by-price profile, never assumed). Structurally high hit rate with negative skew: the adverse-flow, momentum, clarity and lockup gates exist to dodge the rare collapse that erases many small wins.", whyMissed: "Naive favorite-buying ignores that one 90c collapse costs ~18 small wins; harvesting the bias safely is a risk-gating problem, not a signal problem.", dataSources: ["polymarket_gamma", "polymarket_clob"], categoryScope: ["all"], status: "paper_testing", killCriteria: "measured 1h hit rate < 55% over 100 signals, or net drift after per-signal friction ≤ 0, or drift-by-price profile shows no positive curvature in the 80–100c buckets after 300 samples" },
  // ideas — recorded, not built (honest backlog)
  { id: "resolution_source_lag", name: "Resolution Source Lag", thesis: "Official resolution sources publish before markets reprice; generalizes ECL beyond crypto.", dataSources: ["federal_register", "nws"], categoryScope: ["politics", "weather", "macro"], status: "idea", killCriteria: "no measurable lag after 30 mapped events" },
  { id: "attention_imbalance", name: "Attention Imbalance Index", thesis: "News volume spiking without price movement (or vice versa) flags hidden lag or informed flow.", dataSources: ["gdelt"], categoryScope: ["politics", "geopolitics"], status: "idea", killCriteria: "GDELT fails DATA VALIDATION (freshness/terms), or index has no forward correlation over 100 observations" },
  { id: "policy_momentum", name: "Policy Momentum Index", thesis: "Bill/rulemaking cadence from official sources leads policy-linked market repricing.", dataSources: ["congress_gov", "federal_register", "regulations_gov", "usaspending"], categoryScope: ["politics"], status: "idea", killCriteria: "requires CONGRESS_GOV_API_KEY; kill if mapped markets show no drift over 50 events" },
  { id: "calendar_shock", name: "Official Calendar Shock", thesis: "Scheduled releases (CPI/jobs/Fed/EIA/NWS) collapse uncertainty at known times; trade only AFTER official publication.", dataSources: ["bls", "fred", "eia", "nws", "fed_calendar"], categoryScope: ["macro", "fed_rates", "weather"], status: "idea", killCriteria: "release-to-reprice window proves < internal latency (untradable)" },
  { id: "liquidity_vacuum", name: "Liquidity Vacuum Detector", thesis: "Active-looking books where <$200 of flow moves the touch 1c — displayed prices rest on air. Protective screen; depth gates in directional strategies enforce it.", dataSources: ["polymarket_clob"], categoryScope: ["all"], status: "shadow_live", killCriteria: "n/a — protective screen" },
  { id: "mm_absence", name: "Market Maker Absence", thesis: "Sudden spread blowout vs the market's own rolling baseline (≥2.5× and +2c in a normally-tight book) indicates a withdrawn liquidity provider; directional only with a proven positioned wallet.", dataSources: ["polymarket_clob", "polymarket_data"], categoryScope: ["all"], status: "paper_testing", killCriteria: "1h drift after the blown-out spread's own friction ≤ 0 over 30 directional signals; or refill speed beats detection" },
  { id: "rule_ambiguity_short_circuit", name: "Rule Ambiguity Short-Circuit", thesis: "Markets priced certain while wording is ambiguous are uninvestable regardless of model edge — a protection implemented as the rule-clarity gate in every live strategy.", dataSources: ["polymarket_gamma", "kalshi_public"], categoryScope: ["all"], status: "shadow_live", killCriteria: "n/a — protective screen" },
  { id: "capital_lockup", name: "Capital Lockup Penalty", thesis: "Edge smaller than the cost of locking capital to settlement is not edge — implemented as a sizing/gating penalty in wallet strategies.", dataSources: [], categoryScope: ["all"], status: "shadow_live", killCriteria: "n/a — accounting rule" },
  { id: "flow_toxicity", name: "Flow Toxicity Index", thesis: "Structural tape read (imbalance, size concentration, burstiness, alternation) classifying flow as informed / market-making / noise — context for other strategies, never a trade.", dataSources: ["polymarket_data", "polymarket_clob"], categoryScope: ["all"], status: "shadow_live", killCriteria: "n/a — informational context; retire if the read proves uncorrelated with subsequent drift over 200 classified tapes" },
  { id: "specialist_consensus", name: "Category Specialist Consensus/Conflict", thesis: "Independent proven specialists agreeing raises confidence; disagreement blocks size.", dataSources: ["polymarket_data"], categoryScope: ["all"], status: "idea", killCriteria: "needs ≥5 proven specialists per category — currently below sample" },
  { id: "stale_book_trap", name: "Stale Book Trap", thesis: "Displayed edge that exists only on a stale book is fake — implemented as freshness gates + tradability tracking on every outcome.", dataSources: ["polymarket_clob"], categoryScope: ["all"], status: "shadow_live", killCriteria: "n/a — protective screen" },
  { id: "phantom_depth", name: "Phantom Depth", thesis: "Depth that retreats when approached was never depth: diffing consecutive book snapshots against the tape isolates near-touch liquidity that vanished WITHOUT trading — the displayed book overstates what a taker could get.", whyMissed: "Requires remembering the previous snapshot and reconciling against prints; single-snapshot tooling can't see flicker.", dataSources: ["polymarket_clob"], categoryScope: ["all"], status: "shadow_live", killCriteria: "n/a — protective screen; retire if phantom share proves uncorrelated with realized slippage over 200 flagged books" },
  { id: "confluence_matrix", name: "Signal Confluence Matrix", thesis: "The interaction term between strategies is unpriced: when two independent strategies fire on the same market within minutes, measured joint drift vs solo baselines reveals which combinations ADD information and which merely double-count the same fact.", whyMissed: "Requires a per-signal outcome archive nobody keeps; signals are conventionally studied in isolation.", dataSources: ["polymarket_clob"], categoryScope: ["all"], status: "shadow_live", killCriteria: "no pair shows |lift| > friction over 50 joint observations — interactions carry nothing" },
  { id: "drift_price_profile", name: "Drift-by-Price Profile (own-book calibration)", thesis: "The venue's favorite–longshot bias, measured from OUR OWN outcome archive by price bucket instead of cited from literature — a self-learning calibration curve over the exact universe we trade.", whyMissed: "Requires accumulated first-party outcome data; literature curves are for other venues, other eras.", dataSources: ["polymarket_clob"], categoryScope: ["all"], status: "shadow_live", killCriteria: "profile stays flat within noise after 500 bucketed samples — no exploitable curvature" },
  // novel concepts — recorded with theses + kill criteria, awaiting build
  { id: "event_entropy_clock", name: "Event Entropy Clock", thesis: "A multi-outcome event's Shannon entropy should decay toward resolution as information arrives. Events whose entropy RISES without news = structural disagreement; events whose entropy decays far slower than their deadline curve = unpriced time. Generalizes deadline curvature from one market to whole outcome sets.", whyMissed: "Requires event-level (not market-level) bookkeeping across every outcome simultaneously.", dataSources: ["polymarket_gamma"], categoryScope: ["all"], status: "idea", killCriteria: "entropy trajectory shows no forward relationship with repricing over 100 tracked events" },
  { id: "focal_pinning", name: "Focal Pinning", thesis: "Prices cluster at focal numbers (10/25/50/75/90c) more than any smooth belief distribution implies — behavioral anchoring. A closing-soon market PINNED at a focal point with live uncertainty around it is lazily priced; true probabilities rarely sit exactly on round numbers.", whyMissed: "Requires measuring the universe's price distribution against a smooth null, not just looking at one market.", dataSources: ["polymarket_gamma"], categoryScope: ["all"], status: "idea", killCriteria: "focal buckets show no excess mass vs neighbors, or pinned markets reprice no differently over 200 observations" },
  { id: "narrative_half_life", name: "Narrative Half-Life", thesis: "Each category has a characteristic repricing speed — how long news takes to be fully absorbed. Measured per-category from our own decay curves, it sets honest per-category TTLs and horizons instead of one global constant.", whyMissed: "Requires per-category decay curves from a first-party outcome archive.", dataSources: ["polymarket_clob"], categoryScope: ["all"], status: "idea", killCriteria: "category half-lives are statistically indistinguishable — one constant suffices" },
  { id: "circadian_baseline", name: "Circadian Baselines", thesis: "Spreads and depth breathe with the clock: 3am books are structurally wider than 3pm books. Hour-of-day baselines stop mm_absence from crying wolf at known-wide hours and expose ABNORMAL width for the hour — a sharper anomaly than a flat baseline can see.", whyMissed: "Requires per-market per-hour baseline storage most tooling skips.", dataSources: ["polymarket_clob"], categoryScope: ["all"], status: "idea", killCriteria: "hour-of-day explains <10% of spread variance — flat baselines suffice" },
  { id: "free_data_divergence", name: "Free Data Divergence", thesis: "Coinbase vs CoinGecko vs venue price conflicts flag bad data before it becomes a bad trade.", dataSources: ["coinbase_public", "coingecko"], categoryScope: ["crypto"], status: "idea", killCriteria: "divergences prove to be pure CoinGecko aggregation lag (no venue information)" },
  { id: "release_race", name: "Public Data Release Race", thesis: "Pre-map exact official endpoints and release times; act only after official public release, faster than manual readers.", dataSources: ["bls", "fred", "eia"], categoryScope: ["macro"], status: "idea", killCriteria: "requires keys + calendar feature; kill if venue reprices within our fetch latency" },
  { id: "edge_decay_curve", name: "Edge Decay Curve", thesis: "Measure how fast every signal's edge disappears; the curve decides actionability — implemented as the outcome tracker feeding every other feature.", dataSources: ["polymarket_clob"], categoryScope: ["all"], status: "shadow_live", killCriteria: "n/a — measurement infrastructure" },
  { id: "disclosure_radar", name: "Disclosure Radar (context)", thesis: "Official disclosures and rulemaking are DELAYED context for policy-linked markets — never a real-time trigger.", dataSources: ["federal_register", "house_disclosures", "senate_disclosures"], categoryScope: ["politics"], status: "data_connected", killCriteria: "mapped markets show zero incremental context value after 100 disclosures" },
];

// ── Seeding ──────────────────────────────────────────────────────────────────

export async function ensureSeeded(): Promise<void> {
  const now = Date.now();
  const sources = await listSources();
  if (sources.length === 0) {
    await saveSources(seedSourceRecords(now));
    await audit("system", "alpha_sources_seeded", `Free API registry seeded with ${seedSourceRecords(now).length} sources`, {});
  }
  const features = await listFeatures();
  // reconcile stored lifecycle positions with newly-shipped code: when a
  // feature's seed status advanced because its strategy now EXISTS (idea →
  // paper_testing/shadow_live), upgrade stored rows that are still earlier
  // in the lifecycle. Upgrade-only: runtime progress and human decisions
  // (promoted/degraded/retired/rejected) are never touched.
  const RANK: Partial<Record<AlphaFeatureStatus, number>> = {
    idea: 0, data_connected: 1, backtesting: 2, paper_testing: 3, shadow_live: 4,
  };
  let reconciled = 0;
  // append seeds that did not exist when this store was first seeded — new
  // concepts keep flowing into an already-initialized foundry
  const known = new Set(features.map((f) => f.id));
  for (const s of FEATURE_SEEDS) {
    if (known.has(s.id)) continue;
    features.push({ ...s, createdAt: now, updatedAt: now });
    reconciled += 1;
  }
  for (const f of features) {
    const seed = FEATURE_SEEDS.find((s) => s.id === f.id);
    if (!seed) continue;
    const cur = RANK[f.status];
    const target = RANK[seed.status];
    if (cur !== undefined && target !== undefined && target > cur) {
      f.status = seed.status;
      f.thesis = seed.thesis;
      f.killCriteria = seed.killCriteria;
      f.updatedAt = now;
      reconciled += 1;
    }
  }
  if (reconciled > 0) {
    await saveFeatures(features);
    await audit("system", "alpha_features_reconciled", `${reconciled} feature(s) advanced to match newly-shipped strategy code (upgrade-only lifecycle reconcile)`, {});
  }
  // heal stores seeded before the no-synthesized-promotions fix: an approval
  // whose approver is the seed itself is not a human approval
  const synthetic = features.filter((f) => f.humanApprovedBy?.startsWith("seed:"));
  if (synthetic.length > 0) {
    for (const f of synthetic) {
      f.status = "shadow_live";
      f.humanApprovedAt = undefined;
      f.humanApprovedBy = undefined;
      f.promotedAt = undefined;
      f.updatedAt = now;
    }
    await saveFeatures(features);
    await audit("system", "alpha_seed_promotions_revoked", `Revoked ${synthetic.length} seed-synthesized promotion(s) — promotion requires a real human approval on /foundry`, { severity: "warn" });
  }
  if (features.length === 0) {
    const rows: AlphaFeature[] = FEATURE_SEEDS.map((s) => ({
      ...s,
      alphaScore: undefined,
      createdAt: now,
      updatedAt: now,
    }));
    await saveFeatures(rows);
    await audit("system", "alpha_features_seeded", `Alpha Foundry seeded with ${rows.length} features (${rows.filter((f) => f.status === "idea").length} ideas, ${rows.filter((f) => f.status === "paper_testing").length} in paper testing, 0 promoted — live routing stays closed until a human promotes a feature on /foundry)`, {});
  }
}

// ── Evidence + scoring ───────────────────────────────────────────────────────

export interface FeatureWithEvidence extends AlphaFeature {
  evidence: FeatureEvidence;
}

export async function featuresWithEvidence(): Promise<FeatureWithEvidence[]> {
  await ensureSeeded();
  const [features, outcomes, sources] = await Promise.all([
    listFeatures(),
    allOutcomes(),
    listSources(),
  ]);
  return features.map((f) => {
    const evidence = summarizeEvidence(f.id, outcomes);
    const reliability = sourceReliability(f, sources);
    const scored = alphaScore(evidence, { sourceReliability: reliability });
    return {
      ...f,
      alphaScore: scored?.score ?? f.alphaScore,
      alphaComponents: scored?.components ?? f.alphaComponents,
      evidence,
    };
  });
}

function sourceReliability(f: AlphaFeature, sources: SourceRecord[]): number {
  const rows = f.dataSources
    .map((id) => sources.find((s) => s.sourceId === id))
    .filter((s): s is SourceRecord => !!s);
  if (rows.length === 0) return 0.8;
  return rows.reduce((a, s) => a + s.reliabilityScore, 0) / rows.length;
}

export async function runProsecutor(featureId: string): Promise<ProsecutorVerdict | null> {
  const store = await getStore();
  const [features, outcomes, sources, settings] = await Promise.all([
    listFeatures(),
    allOutcomes(),
    listSources(),
    store.getSettings(),
  ]);
  const feature = features.find((f) => f.id === featureId);
  if (!feature) return null;
  const cutoff = Date.now() - 7 * 86_400_000;
  // the promotion gate must charge the USER'S declared costs, not
  // compile-time defaults — an edge that dies under the configured
  // slippage/fees must die here too
  const verdict = prosecute({
    feature,
    evidence: summarizeEvidence(featureId, outcomes),
    recentEvidence: summarizeEvidence(
      featureId,
      outcomes.filter((o) => o.createdAt >= cutoff),
    ),
    sources,
    slippageBps: settings.slippageBps + settings.feeRateBps,
    maxSpread: settings.maxSpread,
  });
  feature.lastVerdict = verdict;
  feature.updatedAt = Date.now();
  await upsertFeature(feature);
  return verdict;
}

/**
 * Human promotion approval. Only allowed when the prosecutor's latest
 * verdict passed — the human gate is IN ADDITION to evidence, never instead.
 */
export async function approvePromotion(
  featureId: string,
  approvedBy: string,
): Promise<{ ok: boolean; reason?: string }> {
  const verdict = await runProsecutor(featureId);
  if (!verdict)
    return { ok: false, reason: "unknown feature" };
  if (!verdict.passed)
    return { ok: false, reason: `prosecutor blocks promotion: ${verdict.summary}` };
  // re-read AFTER prosecution: runProsecutor persisted the verdict, and
  // mutating a pre-prosecution object here would erase it on write-back
  const f = (await listFeatures()).find((x) => x.id === featureId);
  if (!f) return { ok: false, reason: "unknown feature" };
  // graveyard is terminal from this door: a retired/rejected feature must be
  // consciously revived through the lifecycle, never promoted directly with
  // its failure record still attached
  if (f.status === "retired" || f.status === "rejected") {
    return {
      ok: false,
      reason: `feature is ${f.status} (${f.failureReason ?? "no reason recorded"}) — graveyard features cannot be promoted directly`,
    };
  }
  f.status = "promoted";
  f.humanApprovedAt = Date.now();
  f.humanApprovedBy = approvedBy;
  f.promotedAt = Date.now();
  f.updatedAt = Date.now();
  await upsertFeature(f);
  await audit("user", "alpha_feature_promoted", `Feature ${f.name} promoted (prosecutor passed + human approval by ${approvedBy})`, { severity: "warn" });
  return { ok: true };
}

export async function retireFeature(
  featureId: string,
  reason: string,
  failureClass: AlphaFeature["failureClass"],
  lessons: string,
  revisitable = true,
): Promise<void> {
  const features = await listFeatures();
  const f = features.find((x) => x.id === featureId);
  if (!f) return;
  f.status = "retired";
  f.retiredAt = Date.now();
  f.failureReason = reason;
  f.failureClass = failureClass;
  f.lessons = lessons;
  f.revisitable = revisitable;
  f.updatedAt = Date.now();
  await upsertFeature(f);
  await audit("system", "alpha_feature_retired", `Feature ${f.name} retired: ${reason}`, { severity: "warn" });
}

/**
 * Only PROMOTED features may ever route to live execution. Everything else
 * is research/paper by construction. Consumed by the autopilot live gate.
 */
export async function liveEligibleStrategies(): Promise<Set<string>> {
  await ensureSeeded();
  const features = await listFeatures();
  return new Set(
    features
      .filter((f) => f.status === "promoted" && f.humanApprovedAt)
      .map((f) => f.id),
  );
}

// ── Decay monitor ────────────────────────────────────────────────────────────

export async function runDecayMonitor(): Promise<string[]> {
  const [features, outcomes] = await Promise.all([listFeatures(), allOutcomes()]);
  const cutoff = Date.now() - 7 * 86_400_000;
  // decide first, then apply to a FRESH read: the audit awaits inside this
  // loop leave a window where a concurrent human approval/retire would be
  // erased by writing back this pre-loop snapshot
  const verdicts: { id: string; detail: string }[] = [];
  for (const f of features) {
    if (f.status !== "promoted") continue;
    const lifetime = summarizeEvidence(f.id, outcomes);
    const recent = summarizeEvidence(f.id, outcomes.filter((o) => o.createdAt >= cutoff));
    const verdict = decayVerdict(lifetime, recent);
    if (verdict.decayed) verdicts.push({ id: f.id, detail: verdict.detail });
  }
  const demoted: string[] = [];
  if (verdicts.length) {
    const fresh = await listFeatures();
    for (const v of verdicts) {
      const f = fresh.find((x) => x.id === v.id);
      if (!f || f.status !== "promoted") continue; // state moved on — respect it
      f.status = "degraded";
      f.failureReason = v.detail;
      f.updatedAt = Date.now();
      demoted.push(f.id);
      await audit("system", "alpha_feature_degraded", `Feature ${f.name} DEGRADED: ${v.detail} — live routing disabled`, { severity: "warn" });
    }
    if (demoted.length) await saveFeatures(fresh);
  }
  return demoted;
}

// ── Research agent (deterministic ideation) ──────────────────────────────────

/**
 * Weekly idea generation. This is a structured generator over the source
 * registry and the feature backlog — it proposes REAL unexplored
 * source×category combinations with theses and kill criteria, and never
 * pretends to be an oracle. The spec's research-agent prompt is exported for
 * humans (or an external LLM session) to run richer ideation with.
 */
export const RESEARCH_AGENT_PROMPT =
  "You are the Alpha Foundry Research Agent. Find 10 new legally available public data sources or signal ideas that could create an edge in prediction markets. For each idea, define the market category, data source, API access method, expected latency, alpha thesis, risks, terms-of-use concerns, backtest method, paper-test plan, and kill criteria. Reject any idea requiring scraping, private data, evasion, manipulation, or terms-of-service violation.";

export async function generateResearchIdeas(): Promise<ResearchIdea[]> {
  const [sources, features, existing] = await Promise.all([
    listSources(),
    listFeatures(),
    listIdeas(),
  ]);
  const usedSources = new Set(features.flatMap((f) => f.dataSources));
  const seen = new Set(existing.map((i) => i.title));
  const now = Date.now();
  const fresh: ResearchIdea[] = [];

  for (const s of sources) {
    if (fresh.length >= 10) break;
    if (s.status === "banned" || s.status === "unavailable") continue;
    if (usedSources.has(s.sourceId) && s.status === "active") continue;
    for (const cat of s.marketCategoriesSupported.slice(0, 2)) {
      const title = `${s.sourceName} → ${cat} lag study`;
      if (seen.has(title)) continue;
      fresh.push({
        id: genId("idea"),
        title,
        marketCategory: cat,
        dataSource: s.sourceId,
        accessMethod: s.apiKeyRequired
          ? `free API key (${s.apiKeyEnvVar ?? "see docs"})`
          : "keyless public API",
        expectedLatency: s.updateFrequency,
        alphaThesis: `Timestamp ${s.sourceName} updates against ${cat} market repricing; if the source consistently leads by more than our internal latency, a resolution-source-lag feature is testable.`,
        risks: `Source cadence (${s.updateFrequency}) may be slower than market repricing; ${s.status !== "active" ? `source is currently ${s.status}; ` : ""}mapping source events to market IDs may be ambiguous.`,
        termsConcerns: `${s.allowedUse}${s.prohibitedUse ? ` — prohibited: ${s.prohibitedUse}` : ""}`,
        backtestMethod:
          "Point-in-time replay: store source timestamps + market snapshots, replay with purged walk-forward windows, include spread/slippage/latency.",
        paperTestPlan:
          "Run as paper-testing strategy through the outcome tracker (5s/30s/5m/1h/24h decay buckets) for ≥100 signals across ≥7 days.",
        killCriteria:
          "Reject if 1h drift after friction ≤ 0, if one market explains >25% of drift, or if source freshness cannot meet the strategy's gate.",
        status: "proposed",
        createdAt: now,
      });
      seen.add(title);
      if (fresh.length >= 10) break;
    }
  }
  if (fresh.length) {
    await saveIdeas([...existing, ...fresh]);
    await audit("scanner", "alpha_research_ideas", `Research agent proposed ${fresh.length} new source×category ideas`, {});
  }
  return fresh;
}

// ── Source health ────────────────────────────────────────────────────────────

/** minimum spacing between health sweeps — the API route has no other gate */
const HEALTH_MIN_INTERVAL_MS = 10 * 60_000;
const hstate = globalThis as unknown as { __eqHealthAt?: number };

export async function runSourceHealthChecks(): Promise<number> {
  // cooldown: a spammed POST /api/alpha/sources must not re-ping every
  // external endpoint on each call
  const last = hstate.__eqHealthAt ?? 0;
  if (Date.now() - last < HEALTH_MIN_INTERVAL_MS) return 0;
  hstate.__eqHealthAt = Date.now();

  const sources = await listSources();
  // probe first, then apply results to a FRESH read: the probe loop takes
  // seconds-to-minutes, and writing the pre-loop snapshot back would erase
  // any recordSourceOutcome (e.g. a GDELT failure) landed meanwhile
  const results = new Map<
    string,
    Partial<Pick<SourceRecord, "lastLatencyMs" | "lastSuccessfulCall" | "lastFailedCall" | "lastError">> & {
      ok: boolean;
    }
  >();
  for (const s of sources) {
    if (!s.healthPath || s.status === "banned" || s.status === "unavailable") continue;
    const url = `${s.baseUrl}${s.healthPath}`;
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: "application/json", "user-agent": "eventquant-terminal (source-health)" },
      });
      clearTimeout(timer);
      results.set(s.sourceId, {
        ok: res.ok,
        lastLatencyMs: Date.now() - t0,
        ...(res.ok ? { lastSuccessfulCall: Date.now() } : { lastFailedCall: Date.now(), lastError: `HTTP ${res.status}` }),
      });
    } catch (err) {
      results.set(s.sourceId, {
        ok: false,
        lastLatencyMs: Date.now() - t0,
        lastFailedCall: Date.now(),
        lastError: String(err).slice(0, 120),
      });
    }
  }
  const fresh = await listSources();
  for (const s of fresh) {
    const r = results.get(s.sourceId);
    if (!r) continue;
    const { ok: _ok, ...fields } = r;
    Object.assign(s, fields);
    if (r.ok) {
      s.reliabilityScore = Math.min(1, s.reliabilityScore * 0.9 + 0.1);
      if (s.status === "degraded") s.status = "active";
    } else {
      s.reliabilityScore = Math.max(0, s.reliabilityScore * 0.9);
      if (s.status === "active") s.status = "degraded";
    }
  }
  if (results.size) await saveSources(fresh);
  return results.size;
}

// ── Background ticker ────────────────────────────────────────────────────────

interface FoundryGlobal {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}

const g = globalThis as unknown as { __eqFoundry?: FoundryGlobal };

function tstate(): FoundryGlobal {
  if (!g.__eqFoundry) g.__eqFoundry = { timer: null, running: false };
  return g.__eqFoundry;
}

export async function foundryTick(force = false): Promise<Record<string, unknown>> {
  const s = tstate();
  if (s.running) return { skipped: true };
  s.running = true;
  try {
    const store = await getStore();
    const settings = await store.getSettings();
    if (!settings.alpha.foundryEnabled && !force) return { skipped: true, reason: "foundry disabled" };
    await ensureSeeded();
    const runs = await getLastRuns();
    const now = Date.now();
    const did: Record<string, unknown> = {};

    // per-task failures land in the runtime error log (deduped, persisted),
    // not just in this tick's transient return value
    const fail = (task: string) => (e: unknown) => {
      logError(`foundry:${task}`, e);
      return `error: ${e}`;
    };

    // wallet intel — every ~10 min (feeds live wallet strategies)
    if (!runs.intelAt || now - runs.intelAt > 10 * 60_000) {
      did.intelMarkets = await refreshWalletIntel().catch(fail("wallet_intel"));
      await patchLastRuns({ intelAt: now });
    }
    // source health — hourly
    if (!runs.sourceHealthAt || now - runs.sourceHealthAt > 60 * 60_000) {
      did.sourcesChecked = await runSourceHealthChecks().catch(fail("source_health"));
      await patchLastRuns({ sourceHealthAt: now });
    }
    // decay monitor — hourly
    if (!runs.decayAt || now - runs.decayAt > 60 * 60_000) {
      did.demoted = await runDecayMonitor().catch((e) => [fail("decay_monitor")(e)]);
      await patchLastRuns({ decayAt: now });
    }
    // wallet discovery + rescoring — daily
    if (!runs.discoveryAt || now - runs.discoveryAt > 20 * 60 * 60_000) {
      try {
        const { markets } = await getMarkets();
        const top = [...markets]
          .filter((m) => m.venueId === "polymarket")
          .sort((a, b) => b.volume24h - a.volume24h);
        did.discovery = await discoverWallets(top);
        did.rescored = await rescoreTrackedWallets();
      } catch (e) {
        did.discovery = fail("wallet_discovery")(e);
      }
      await patchLastRuns({ discoveryAt: now });
    }
    // disclosures — every 6h
    if (!runs.disclosuresAt || now - runs.disclosuresAt > 6 * 60 * 60_000) {
      did.disclosures = await refreshDisclosures().catch(fail("disclosures"));
      await patchLastRuns({ disclosuresAt: now });
    }
    // attention (GDELT) — every 6h; sequential fetches respect the 1/5s limit
    if (!runs.attentionAt || now - runs.attentionAt > 6 * 60 * 60_000) {
      const { refreshAttention } = await import("./attention");
      did.attention = await refreshAttention().catch(fail("attention"));
      await patchLastRuns({ attentionAt: now });
    }
    // research ideation — weekly
    if (!runs.researchAt || now - runs.researchAt > 7 * 86_400_000) {
      did.ideas = (await generateResearchIdeas().catch(() => [])).length;
      await patchLastRuns({ researchAt: now });
    }
    // walk-forward backtests — weekly per replayable feature, so replay
    // evidence stays current without anyone remembering to click
    if (!runs.backtestAt || now - runs.backtestAt > 7 * 86_400_000) {
      try {
        const { runWalkForwardBacktest } = await import("./backtester");
        const { replayableFeatures } = await import("@/lib/alpha/walkforward");
        const ran: string[] = [];
        for (const id of replayableFeatures()) {
          const res = await runWalkForwardBacktest(id).catch(() => null);
          if (res?.ok) ran.push(id);
        }
        did.backtested = ran;
      } catch (e) {
        did.backtested = fail("backtests")(e);
      }
      await patchLastRuns({ backtestAt: now });
    }
    return did;
  } finally {
    s.running = false;
  }
}

/** lazily start the foundry loop (5-min cadence; work is gated per-task) */
export function ensureFoundryTicker(): void {
  if (process.env.DISABLE_EMBEDDED_SCANNER === "true") return;
  const s = tstate();
  if (s.timer) return;
  s.timer = setInterval(() => {
    foundryTick(false).catch((err) => {
      logError("foundry:tick", err);
      console.error("[eventquant] foundry tick failed:", err);
    });
  }, 5 * 60_000);
  if (typeof s.timer === "object" && "unref" in s.timer) s.timer.unref();
}

export { isGraveyard };
