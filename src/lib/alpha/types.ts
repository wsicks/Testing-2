// Alpha Foundry domain types — the continuous research machine's data model.
//
// Everything here is EVIDENCE-shaped: sources carry terms/reliability state,
// wallets carry per-dimension skill with sample sizes, features carry a
// lifecycle with prosecutor verdicts, and outcomes carry measured (not
// promised) forward drift. Nothing in this module represents guaranteed
// profit; it represents measurements with their limitations attached.

// ── Free API registry ─────────────────────────────────────────────────────────

export type SourceRegistryStatus =
  | "active" // verified reachable, terms reviewed, in use or usable
  | "degraded" // recent failures or stale data
  | "disabled" // not usable yet (usually: free API key required but not configured)
  | "banned" // terms forbid our use — never call
  | "manual_review" // no structured/permitted API found; human must review
  | "unavailable"; // no permitted source exists for this category

export type SourceCategory =
  | "prediction_markets"
  | "crypto"
  | "macro"
  | "politics_regulation"
  | "weather_climate"
  | "news_events"
  | "sports";

export interface SourceRecord {
  sourceId: string;
  sourceName: string;
  category: SourceCategory;
  baseUrl: string;
  docsUrl?: string;
  officialSource: boolean;
  freeAvailable: boolean;
  apiKeyRequired: boolean;
  /** env var that unlocks the source when a (free) key is required */
  apiKeyEnvVar?: string;
  authenticationType: "none" | "api_key" | "oauth" | "user_agent";
  rateLimit: string;
  latencyEstimateMs?: number;
  updateFrequency: string;
  historicalDepth?: string;
  allowedUse: string;
  prohibitedUse?: string;
  commercialUseAllowed: "yes" | "no" | "conditions" | "unknown";
  redistributionAllowed: "yes" | "no" | "conditions" | "unknown";
  /** 0–1, from observed call outcomes; seeded neutral */
  reliabilityScore: number;
  /** 0–1, how fresh the data was on last observation */
  freshnessScore?: number;
  signalCategoriesSupported: string[];
  marketCategoriesSupported: string[];
  lastSuccessfulCall?: number;
  lastFailedCall?: number;
  lastError?: string;
  lastLatencyMs?: number;
  /** epoch ms of the last human/agent terms-of-use review */
  lastTermsReview?: number;
  status: SourceRegistryStatus;
  /** honest operational note (why disabled, what unlocks it, …) */
  note?: string;
  /** GET path probed by the health checker; keyless sources only */
  healthPath?: string;
}

// ── Wallet Radar ──────────────────────────────────────────────────────────────

/**
 * canonical market dimensions a wallet is scored on. `cat:` entries come from
 * categorizeMarket(); `dur:`/`liq:` bucket duration and liquidity so a wallet
 * can be a "closing-market sniper" without being globally smart.
 */
export type SkillDimension = string; // "cat:crypto" | "dur:short" | "liq:low" | …

export type WalletLabel =
  | "smart_specialist"
  | "broad_smart_wallet"
  | "early_accumulator"
  | "closing_market_sniper"
  | "liquidity_provider"
  | "whale_not_smart"
  | "lucky_outlier"
  | "high_risk_gambler"
  | "low_sample_unknown"
  | "likely_market_maker"
  | "likely_copier"
  | "possible_wash_noise"
  | "fade_candidate"
  | "ignore";

export interface DimensionSkill {
  dimension: SkillDimension;
  sampleSize: number;
  /** realized ROI on closed positions, AFTER estimated spread+slippage */
  costAdjRoi: number;
  /** raw realized ROI before cost estimates (shown for transparency) */
  rawRoi: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  /** share of total profit explained by the single best trade (1 = all luck) */
  luckyConcentration: number;
  capitalEfficiency: number;
  /** 0–1 composite of sample size and luck-adjustment */
  confidence: number;
}

/** measured drift after WE detected this wallet's entries (forward evidence) */
export interface ForwardEvidence {
  samples: number;
  /** avg direction-adjusted 1h drift in probability points */
  avgDrift1h: number;
  /** avg drift already consumed within 5s of detection (copyability) */
  avgDrift5s: number;
  updatedAt: number;
}

export interface TrackedWalletRecord {
  walletId: string; // lowercase proxy wallet address (public, on-chain)
  /** public display name from Polymarket's own API — never inferred identity */
  pseudonym?: string;
  publicProfileUrl?: string;
  label: WalletLabel;
  labels: WalletLabel[];
  firstSeen: number;
  lastSeen: number;
  manuallyAdded: boolean;
  autoDiscovered: boolean;
  status: "candidate" | "tracked" | "rejected" | "archived";
  rejectReason?: string;
  candidateScore?: number;
  totalClosed: number;
  totalPnl: number;
  costAdjTotalRoi: number;
  dimensions: DimensionSkill[];
  forward?: ForwardEvidence;
  notes?: string;
  lastScoredAt?: number;
  lastIntelAt?: number;
}

/** one tracked wallet's live stance in one market (built cold-path) */
export interface WalletMarketEntry {
  walletId: string;
  displayName?: string;
  label: WalletLabel;
  side: "YES" | "NO";
  avgEntryPrice: number;
  sizeUsd: number;
  /** most recent BUY on this side, epoch ms */
  lastTradeTs: number;
  /** number of separate BUY trades (accumulation evidence) */
  entries: number;
  stillHolding: boolean;
  /** recent SELLs against the position detected */
  exiting: boolean;
  /** skill on THIS market's category dimension, if scored */
  dimensionSkill?: DimensionSkill;
  forward?: ForwardEvidence;
}

export interface MarketWalletIntel {
  entries: WalletMarketEntry[];
  /** how many tracked wallets share the most crowded side */
  crowdSameSide: number;
  updatedAt: number;
}

export interface MimicBlock {
  reason: string;
  detail: string;
}

export interface MimicAssessment {
  score: number; // 0–100
  components: Record<string, number>;
  blocks: MimicBlock[];
  remainingEdge: number;
  friction: number;
  maxSizeUsd: number;
  recommendation: "copy" | "fade" | "confirm_only" | "watch" | "block";
}

// ── Alpha feature lifecycle ───────────────────────────────────────────────────

export type AlphaFeatureStatus =
  | "idea"
  | "data_connected"
  | "backtesting"
  | "rejected"
  | "paper_testing"
  | "shadow_live"
  | "promoted"
  | "degraded"
  | "retired";

export interface ProsecutorTest {
  name: string;
  passed: boolean;
  evidence: string;
  value?: number;
  threshold?: number;
}

export interface ProsecutorVerdict {
  featureId: string;
  ranAt: number;
  tests: ProsecutorTest[];
  passed: boolean;
  summary: string;
}

export interface AlphaFeature {
  id: string; // = strategy id when the feature is a live strategy
  name: string;
  thesis: string;
  /** why other traders might miss it */
  whyMissed?: string;
  dataSources: string[]; // sourceIds from the registry
  categoryScope: string[];
  status: AlphaFeatureStatus;
  /** composite score; null until enough evidence exists */
  alphaScore?: number;
  alphaComponents?: Record<string, number>;
  killCriteria: string;
  backtestPlan?: string;
  paperPlan?: string;
  /** graveyard fields */
  failureReason?: string;
  failureClass?:
    | "no_edge"
    | "overfit"
    | "slippage"
    | "latency"
    | "low_liquidity"
    | "bad_data"
    | "bad_mapping"
    | "rule_ambiguity"
    | "source_terms"
    | "decay";
  lessons?: string;
  revisitable?: boolean;
  /** promotion requires prosecutor pass AND an explicit human approval */
  humanApprovedAt?: number;
  humanApprovedBy?: string;
  promotedAt?: number;
  retiredAt?: number;
  lastVerdict?: ProsecutorVerdict;
  /** latest purged walk-forward replay (price-replayable features only) */
  lastBacktest?: import("./walkforward").WalkForwardResult;
  createdAt: number;
  updatedAt: number;
}

// ── Outcome / decay tracking ──────────────────────────────────────────────────

export type DecayBucketKey = "b5s" | "b30s" | "b5m" | "b1h" | "b24h";

export interface DecayBucket {
  /** direction-adjusted drift in probability points; positive = signal right */
  drift?: number;
  /** epoch ms the capture actually happened (may differ from the target) */
  at?: number;
  /** capture window passed without a capture (restart, market gone, …) */
  missed?: boolean;
}

export interface AlphaOutcome {
  id: string;
  featureId: string; // strategy id
  signalId: string;
  conditionId: string;
  direction: "BUY_YES" | "BUY_NO";
  entryMid: number;
  spreadAtSignal?: number;
  bookAgeMsAtSignal?: number;
  /** spread ≤ maxSpread and a book existed → the signal was actually fillable */
  tradable: boolean;
  wasProposed: boolean;
  walletId?: string;
  /**
   * sign relating SIGNAL-direction drift to the WALLET's own drift: +1 when
   * the signal follows the wallet (wallet_shadow), −1 when it fades it
   * (wallet_fade). Without this, successful fades would credit the faded
   * wallet with positive forward evidence.
   */
  walletSign?: 1 | -1;
  createdAt: number;
  buckets: Partial<Record<DecayBucketKey, DecayBucket>>;
}

export interface DecayCurvePoint {
  bucket: DecayBucketKey;
  n: number;
  missed: number;
  avgDrift: number;
}

export interface FeatureEvidence {
  featureId: string;
  outcomes: number;
  tradableOutcomes: number;
  proposedOutcomes: number;
  distinctMarkets: number;
  distinctDays: number;
  avgSpread: number;
  staleShare: number;
  luckyConcentration: number;
  maxAdverseRun: number;
  curve: DecayCurvePoint[];
  firstAt?: number;
  lastAt?: number;
}

// ── Disclosure Radar ─────────────────────────────────────────────────────────

export interface DisclosureRecord {
  id: string;
  source: string; // sourceId
  docType: string;
  title: string;
  url: string;
  /** ISO publication/filing date */
  filingDate: string;
  transactionDate?: string;
  /** days between the event and the public filing — delayed info, always */
  lagDays?: number;
  agency?: string;
  sector?: string;
  policyTags: string[];
  relatedMarkets: { conditionId: string; question: string; overlap: number }[];
  confidence: number;
  /** contextual signal ONLY — never an automatic trade */
  humanReviewRequired: true;
  fetchedAt: number;
}

// ── Research agent ───────────────────────────────────────────────────────────

export interface ResearchIdea {
  id: string;
  title: string;
  marketCategory: string;
  dataSource: string;
  accessMethod: string;
  expectedLatency: string;
  alphaThesis: string;
  risks: string;
  termsConcerns: string;
  backtestMethod: string;
  paperTestPlan: string;
  killCriteria: string;
  status: "proposed" | "accepted" | "declined" | "converted";
  createdAt: number;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export type WalletFollowMode =
  | "watch_only"
  | "confirm_only"
  | "paper_mimic"
  | "paper_fade";

export interface AlphaSettings {
  /** master switch for the foundry background research loop */
  foundryEnabled: boolean;
  walletFollowMode: WalletFollowMode;
  /**
   * live wallet-copying stays OFF by default. Even when true, live orders
   * still require the wallet strategy to be PROMOTED (prosecutor + human
   * approval), the per-venue live gate, and per-order confirmation.
   */
  walletLiveEnabled: boolean;
  /** block copy when price moved more than this from the wallet's entry */
  maxCopyDriftCents: number;
  maxWalletEntryAgeMin: number;
  minWalletSampleSize: number;
  minWalletForwardSamples: number;
  /** hard cap on any experimental/mimic test order */
  testOrderUsd: number;
}
