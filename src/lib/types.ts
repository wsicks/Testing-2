// Core domain types shared across the terminal, engines, and API layer.

export type TerminalMode = "demo" | "paper" | "live";

// ── Venues ────────────────────────────────────────────────────────────────────

export type VenueId = "polymarket" | "kalshi" | "coinbase" | "coingecko";

export interface VenueCapabilities {
  publicData: boolean;
  orderBooks: boolean;
  candles: boolean;
  trades: boolean;
  paperTrading: boolean;
  /** live adapter exists (still locked behind per-venue gates) */
  liveTrading: boolean;
  /** reference-only source — can never execute anything */
  referenceOnly: boolean;
}

/** transparency record every external data source must expose */
export interface SourceStatus {
  venueId: VenueId;
  name: string;
  licenseNote: string;
  updateFrequency: string;
  rateLimitNote: string;
  dataClass: "tradable" | "reference" | "delayed" | "estimated";
  requests: number;
  failures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
  /** ms since last successful fetch; undefined = never succeeded */
  freshnessMs?: number;
}

export interface NormalizedCandle {
  /** epoch seconds, bar open */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ReferencePrice {
  source: VenueId;
  symbol: string;
  price: number;
  change24hPct?: number;
  volume24h?: number;
  ts: number;
  freshnessMs: number;
}

export interface VenueSettings {
  publicData: boolean;
  paperTrading: boolean;
  /** per-venue live opt-in — enabling one venue NEVER enables another */
  liveEnabled: boolean;
}

// ── Markets ───────────────────────────────────────────────────────────────────

export interface MarketOutcome {
  tokenId: string;
  label: string;
  price?: number;
}

export interface NormalizedMarket {
  /**
   * universal internal market key. Polymarket keeps its raw conditionId for
   * backward compatibility; other venues use a prefixed id (ks:TICKER,
   * cb:BTC-USD) so keys never collide across venues.
   */
  conditionId: string;
  venueId: VenueId;
  /** the venue's native identifier (condition id, ticker, product id) */
  venueMarketId: string;
  venueTicker?: string;
  gammaId?: string;
  slug?: string;
  eventSlug?: string;
  question: string;
  eventTitle?: string;
  description?: string;
  /** name/url of the venue's stated resolution source, when provided */
  resolutionSource?: string;
  category?: string;
  tags: string[];
  endDate?: string;
  startDate?: string;
  active: boolean;
  closed: boolean;
  negRisk: boolean;
  /** binary = 0..1 outcome tokens; asset = spot product (crypto reference) */
  outcomeType: "binary" | "asset";
  liquidity: number;
  volume24h: number;
  volumeTotal: number;
  openInterest?: number;
  tickSize?: number;
  minOrderSize?: number;
  outcomes: MarketOutcome[];
  yesTokenId?: string;
  noTokenId?: string;
  yesPrice?: number;
  noPrice?: number;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  midpoint?: number;
  oneDayPriceChange?: number;
  oneHourPriceChange?: number;
  /** true when created within the "new market" window */
  isNew?: boolean;
  /** orders may be routed here (paper always; live behind per-venue gates) */
  tradable: boolean;
  /** display/signal input only — can never receive orders */
  referenceOnly: boolean;
  sourceUrl?: string;
  source: "gamma" | "kalshi" | "coinbase" | "mock";
  /** epoch ms when this row was fetched — drives data-freshness checks */
  fetchedAt: number;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBookData {
  tokenId: string;
  /** sorted best-first (descending price) */
  bids: BookLevel[];
  /** sorted best-first (ascending price) */
  asks: BookLevel[];
  bestBid?: number;
  bestAsk?: number;
  midpoint?: number;
  spread?: number;
  /** USD notional resting within 5c of mid on each side */
  bidDepthUsd: number;
  askDepthUsd: number;
  ts: number;
  source: "clob" | "mock";
}

export interface PricePoint {
  /** epoch seconds */
  t: number;
  p: number;
}

export interface RecentTrade {
  side: "BUY" | "SELL";
  price: number;
  size: number;
  ts: number;
  outcome?: string;
}

// ── Signals ───────────────────────────────────────────────────────────────────

export type SignalDirection = "BUY_YES" | "BUY_NO" | "NEUTRAL";
export type SignalStatus = "proposed" | "approved" | "rejected" | "expired";

export interface SignalCheckResult {
  name: string;
  passed: boolean;
  value?: number;
  threshold?: number;
  detail: string;
}

export interface SignalResult {
  id: string;
  strategy: string;
  strategyLabel: string;
  conditionId?: string;
  tokenId?: string;
  marketQuestion?: string;
  category?: string;
  direction: SignalDirection;
  /** 0–100 composite score */
  score: number;
  status: SignalStatus;
  summary: string;
  checks: SignalCheckResult[];
  createdAt: number;
  expiresAt?: number;
  meta?: Record<string, unknown>;
}

export interface SignalContext {
  market: NormalizedMarket;
  book?: OrderBookData;
  /** YES-token price history, oldest first */
  history?: PricePoint[];
  /** recent public trades (tape), newest first */
  trades?: RecentTrade[];
  /** other markets considered by cross-market strategies */
  relatedMarkets?: NormalizedMarket[];
  /** fresh external reference data for crypto-linked markets */
  reference?: {
    spot?: number;
    spotSource?: string;
    spotFreshnessMs?: number;
    /** daily realized volatility of the reference asset (fraction, e.g. 0.03) */
    realizedVolDaily?: number;
  };
  /** cross-venue links involving this market */
  crossLinks?: CrossVenueLink[];
  /** tracked-wallet stances in this market (Wallet Radar, cold-path built) */
  walletIntel?: import("./alpha/types").MarketWalletIntel;
  /** rolling microstructure baseline for this market (spread/liquidity EMAs) */
  baseline?: { spreadEma: number; liquidityEma: number; samples: number };
  /** the PREVIOUS scan's book snapshot for this market's YES token */
  prevBook?: OrderBookData;
  /** alpha/wallet-follow thresholds (subset of AppSettings) */
  alpha?: import("./alpha/types").AlphaSettings;
  settings: RiskSettings;
  now: number;
}

export interface SignalStrategy {
  id: string;
  label: string;
  description: string;
  run(ctx: SignalContext): SignalResult | null;
}

// ── Orders / fills / positions ────────────────────────────────────────────────

export type OrderSide = "BUY" | "SELL";
export type OrderType = "limit" | "market";
export type OrderStatus =
  | "created"
  | "signed"
  | "submitted"
  | "open"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired";

export interface PaperOrder {
  id: string;
  mode: "paper" | "demo";
  conditionId?: string;
  tokenId: string;
  outcome?: string;
  marketTitle?: string;
  category?: string;
  /** who initiated this order */
  origin?: "manual" | "autopilot" | "wallet_mimic";
  side: OrderSide;
  orderType: OrderType;
  price: number;
  /** shares */
  size: number;
  filledSize: number;
  avgFillPrice?: number;
  status: OrderStatus;
  signalId?: string;
  reason?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export type LiveIntentStatus =
  | OrderStatus
  | "previewed"
  | "approval_required"
  | "confirmed";

export interface LiveOrderIntent {
  id: string;
  conditionId?: string;
  tokenId: string;
  outcome?: string;
  marketTitle?: string;
  origin?: "manual" | "autopilot" | "wallet_mimic";
  side: OrderSide;
  orderType: OrderType;
  price: number;
  size: number;
  filledSize: number;
  status: LiveIntentStatus;
  confirmationText?: string;
  approvedAt?: number;
  clobOrderId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface FillRecord {
  id: string;
  orderId?: string;
  intentId?: string;
  mode: TerminalMode;
  tokenId: string;
  outcome?: string;
  marketTitle?: string;
  category?: string;
  conditionId?: string;
  side: OrderSide;
  price: number;
  size: number;
  fee: number;
  ts: number;
  /** realized PnL created by this fill (SELL fills only) */
  realizedPnlDelta?: number;
}

export interface PositionRecord {
  tokenId: string;
  mode: TerminalMode;
  conditionId?: string;
  outcome?: string;
  marketTitle?: string;
  category?: string;
  size: number;
  avgPrice: number;
  realizedPnl: number;
  updatedAt: number;
  // enriched at read time
  markPrice?: number;
  unrealizedPnl?: number;
  value?: number;
}

// ── Risk ──────────────────────────────────────────────────────────────────────

export interface RiskSettings {
  defaultMode: TerminalMode;
  /** max single trade as % of portfolio value */
  maxTradePct: number;
  /** absolute cap on a single trade, USD */
  maxTradeUsd: number;
  maxDailyLossUsd: number;
  /** max exposure to one market, % of portfolio */
  maxMarketExposurePct: number;
  /** max exposure to one category, % of portfolio */
  maxCategoryExposurePct: number;
  minLiquidityUsd: number;
  /** absolute price spread, e.g. 0.03 = 3c */
  maxSpread: number;
  minSignalScore: number;
  orderExpirationMin: number;
  /** fraction of full Kelly to apply, e.g. 0.25 */
  kellyCap: number;
  feeRateBps: number;
  slippageBps: number;
  /** live orders above this notional require typed confirmation */
  typedConfirmThresholdUsd: number;
  /** market data older than this is considered stale */
  staleDataMaxSecs: number;
  /** window (hours) used by the closing-soon scanner */
  closingSoonHours: number;
}

export interface UserPrefs {
  watchlist: string[]; // conditionIds
  categories: string[]; // tags of interest
  termsAcceptedAt?: number;
  liveModeEnabled: boolean;
  killSwitch: boolean;
  scannersEnabled: boolean;
  paperStartingCash: number;
  /**
   * USER-DECLARED live bankroll (USD). The app holds no keys and cannot
   * read venue balances, so this is an assertion, not a measurement — used
   * only as the risk engine's live cash/sizing ceiling. $0 (default) keeps
   * every live BUY fail-closed.
   */
  liveDeclaredCashUsd: number;
  /** Polygon address used for read-only wallet analytics (no keys) */
  watchWallet?: string;
  /** automated-trading policy & envelope */
  autopilot: AutopilotConfig;
  /** Alpha Foundry + Wallet Radar controls */
  alpha: import("./alpha/types").AlphaSettings;
  /** per-venue enablement — live flags are independent per venue */
  venues: Record<Exclude<VenueId, "coingecko">, VenueSettings> & {
    coingecko: { publicData: boolean };
  };
}

export type AppSettings = RiskSettings & UserPrefs;

export interface TradeProposal {
  conditionId?: string;
  tokenId: string;
  outcome?: string;
  marketTitle?: string;
  category?: string;
  side: OrderSide;
  orderType: OrderType;
  price: number;
  /** shares */
  size: number;
  targetPrice?: number;
  stopPrice?: number;
  /** model win-probability estimate used for EV / Kelly */
  winProbability?: number;
  signalScore?: number;
  signalId?: string;
  /**
   * risk-reducing exit of an existing position: microstructure blocks
   * (spread/liquidity/freshness/clarity) downgrade to warnings so positions
   * can always be flattened
   */
  isExit?: boolean;
}

export type RiskLevel = "low" | "medium" | "high";

export interface RiskCheck {
  name: string;
  passed: boolean;
  value?: number;
  limit?: number;
  detail: string;
  severity: "block" | "warn";
}

export interface RiskAssessment {
  approved: boolean;
  checks: RiskCheck[];
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  notionalUsd: number;
  estCostUsd: number;
  maxLossUsd: number;
  expectedValueUsd: number;
  /** edge required to break even after spread+fees+slippage (price units) */
  requiredEdge: number;
  grossEdge: number;
  netEdge: number;
  kellyFraction: number;
  cappedKellyFraction: number;
  suggestedSizeUsd: number;
  suggestedShares: number;
  expectedFillProbability: number;
  slippageEstimate: number;
  portfolioValue: number;
  exposureAfterPct: number;
  marketExposureAfterPct: number;
  categoryExposureAfterPct: number;
  liquidityExitRisk: RiskLevel;
  resolutionAmbiguityRisk: RiskLevel;
  reasons: string[];
}

export interface PortfolioState {
  mode: TerminalMode;
  cash: number;
  totalValue: number;
  exposure: number;
  positions: PositionRecord[];
  exposureByMarket: Record<string, number>;
  exposureByCategory: Record<string, number>;
  exposureByVenue: Record<string, number>;
  realizedPnl: number;
  unrealizedPnl: number;
  dailyPnl: number;
  dailyRealizedPnl: number;
  allTimePnl: number;
  winRate?: number;
  avgRR?: number;
  maxDrawdown?: number;
  liquidityRiskScore?: number;
  closedTrades: number;
  isSample: boolean;
}

// ── Audit & live feed ─────────────────────────────────────────────────────────

export type AuditActor = "system" | "user" | "scanner" | "risk" | "execution";
export type AuditSeverity = "info" | "warn" | "error";

export interface AuditEventRecord {
  id: string;
  ts: number;
  actor: AuditActor;
  type: string;
  severity: AuditSeverity;
  message: string;
  data?: Record<string, unknown>;
}

export type FeedEventType =
  | "market_discovered"
  | "price_moved"
  | "signal_created"
  | "signal_rejected"
  | "risk_check_failed"
  | "order_preview_created"
  | "order_submitted"
  | "order_filled"
  | "order_canceled"
  | "api_error"
  | "ws_reconnect"
  | "user_action"
  | "scanner_tick"
  | "kill_switch"
  | "autopilot_entry"
  | "autopilot_exit"
  | "autopilot_skip"
  | "autopilot_halt"
  | "autopilot_armed"
  | "autopilot_disarmed";

export interface FeedEvent {
  id: string;
  ts: number;
  type: FeedEventType;
  severity: AuditSeverity;
  message: string;
  data?: Record<string, unknown>;
}

// ── Execution cycle ───────────────────────────────────────────────────────────

export type StageStatus =
  | "waiting"
  | "running"
  | "passed"
  | "failed"
  | "approval_required";

export interface ExecutionStage {
  key: "detect" | "validate" | "size" | "execute" | "monitor";
  label: string;
  status: StageStatus;
  detail?: string;
}

// ── Cross-venue intelligence ─────────────────────────────────────────────────

export type CrossVenueMatchStatus =
  | "exact"
  | "strong_candidate"
  | "weak_candidate"
  | "reference_only"
  | "conflict"
  | "not_comparable";

export interface RuleComparisonDimension {
  name: string;
  a?: string;
  b?: string;
  comparable: boolean;
  note: string;
}

export interface CrossVenueLink {
  id: string;
  sourceVenueId: VenueId;
  sourceMarketId: string;
  sourceTitle: string;
  targetVenueId: VenueId;
  targetMarketId: string;
  targetTitle: string;
  matchStatus: CrossVenueMatchStatus;
  matchScore: number;
  /** per-dimension rule comparison — the explainability trail */
  dimensions: RuleComparisonDimension[];
  /** price divergence in probability points when both sides are binary */
  divergence?: number;
  updatedAt: number;
}

export interface CryptoThreshold {
  asset: string; // BTC, ETH, SOL, …
  coinbaseProduct?: string; // BTC-USD
  threshold: number; // USD
  direction: "above" | "below";
  /**
   * terminal = settles on the value AT close ("above $X on <date>");
   * touch = settles if the level trades AT ANY TIME before close
   * ("reach/hit/dip to $X"). Same threshold, very different contracts:
   * P(touch) can be ~2× P(terminal) and current spot alone can prove a touch
   * happened but never that it didn't.
   */
  kind: "terminal" | "touch";
  byDate?: string;
}

// ── Autopilot (automated trading) ────────────────────────────────────────────

export type AutopilotMode = "off" | "observe" | "paper" | "live";

export interface AutopilotConfig {
  mode: AutopilotMode;
  /** strategies the policy may act on */
  enabledStrategies: string[];
  /**
   * maker = post INSIDE the spread and rest briefly (capture ~half the
   * spread instead of paying it — friction is the main measured PnL leak);
   * taker = cross to the ask for an immediate fill
   */
  entryStyle: "maker" | "taker";
  /** minutes a maker entry may rest before the remainder is canceled */
  makerRestMin: number;
  /** minimum signal score to consider an entry */
  minScore: number;
  /** notional per entry, USD (bounded by risk-engine caps) */
  perTradeUsd: number;
  maxOpenPositions: number;
  maxTradesPerHour: number;
  /** total entry notional allowed per armed/enabled session */
  maxSessionNotionalUsd: number;
  /** circuit breaker: realized session loss that halts entries + disarms */
  sessionMaxLossUsd: number;
  /** exit management */
  targetPct: number;
  stopPct: number;
  /** trailing stop distance (activates after price moves in favor) */
  trailPct: number;
  maxHoldMin: number;
  /** flatten positions this many minutes before market close */
  flattenBeforeCloseMin: number;
  /** only trade strategies whose style matches the detected regime */
  requireRegimeMatch: boolean;
}

export interface AutopilotDecision {
  id: string;
  ts: number;
  kind: "entry" | "exit" | "skip" | "halt" | "arm" | "disarm";
  strategy?: string;
  conditionId?: string;
  marketQuestion?: string;
  side?: OrderSide;
  price?: number;
  size?: number;
  reason: string;
  orderId?: string;
  approved?: boolean;
}

export interface BanditArm {
  strategy: string;
  /** Beta posterior over per-trade win probability */
  alpha: number;
  beta: number;
  mean: number;
  /** last Thompson sample drawn (for display) */
  sampled?: number;
  wins: number;
  losses: number;
  realizedPnlUsd: number;
}

export interface AutopilotSession {
  startedAt?: number;
  trades: number;
  notionalUsd: number;
  realizedPnlUsd: number;
  tradesLastHour: number;
  breakerTripped: boolean;
  breakerReason?: string;
  /** live arming expiry (epoch ms); undefined = not armed */
  armedUntil?: number;
  lastTickAt?: number;
}

export interface AutopilotStatus {
  config: AutopilotConfig;
  session: AutopilotSession;
  bandit: BanditArm[];
  decisions: AutopilotDecision[];
  managedPositions: number;
  liveGateOpen: boolean;
  liveGateReasons: string[];
}

/** tracked lot the autopilot manages exits for */
export interface ManagedPosition {
  tokenId: string;
  conditionId?: string;
  marketQuestion?: string;
  outcome?: string;
  strategy: string;
  mode: "paper" | "live";
  entryPrice: number;
  size: number;
  openedAt: number;
  /** best price seen since entry (for trailing stop) */
  peakPrice: number;
  endDate?: string;
  /**
   * mechanical exit plan carried from the signal (ECL: 50% at 60% edge
   * capture, rest at 85%) — prices in the ENTRY token's terms. Takes
   * precedence over the generic %-target once armed.
   */
  exitPlan?: { partialAt: number; fullAt: number };
  /** the plan's 50% tranche has already been taken */
  partialDone?: boolean;
}

// ── Backtesting ───────────────────────────────────────────────────────────────

export interface BacktestConfig {
  strategyId: "momentum" | "mean_reversion" | "closing_drift";
  tokenIds: string[];
  /** epoch seconds */
  from: number;
  to: number;
  initialCapital: number;
  positionPct: number;
  entryThreshold: number;
  holdBars: number;
  targetPct: number;
  stopPct: number;
  feeRateBps: number;
  slippageBps: number;
  spreadAssumption: number;
}

export interface BacktestTrade {
  tokenId: string;
  marketTitle?: string;
  side: OrderSide;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  returnPct: number;
  exitReason: "target" | "stop" | "time" | "series_end";
}

export interface BacktestResult {
  label: string;
  config: BacktestConfig;
  equityCurve: { t: number; equity: number }[];
  drawdownCurve: { t: number; dd: number }[];
  trades: BacktestTrade[];
  stats: {
    totalReturnPct: number;
    maxDrawdownPct: number;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    feesPaid: number;
  };
  assumptions: string[];
  isHistoricalSimulation: true;
}

// ── Monte Carlo ───────────────────────────────────────────────────────────────

export interface MonteCarloConfig {
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  positionPct: number;
  numTrades: number;
  numPaths: number;
  initialCapital: number;
  seed?: number;
}

export interface MonteCarloResult {
  config: MonteCarloConfig;
  finalEquityPercentiles: { p5: number; p25: number; p50: number; p75: number; p95: number };
  maxDrawdownPercentiles: { p5: number; p50: number; p95: number };
  riskOfRuin: number;
  worst5PctOutcome: number;
  expectedFinal: number;
  paths: { t: number; p5: number; p25: number; p50: number; p75: number; p95: number }[];
  histogram: { bucket: number; count: number }[];
  isRiskDisplay: true;
}
