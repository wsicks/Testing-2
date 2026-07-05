"use client";

// TanStack Query hooks over the terminal API.

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  AppSettings,
  AuditEventRecord,
  AutopilotStatus,
  BacktestResult,
  LiveOrderIntent,
  NormalizedMarket,
  OrderBookData,
  PaperOrder,
  PortfolioState,
  PricePoint,
  RecentTrade,
  RiskAssessment,
  SignalResult,
  TerminalMode,
} from "@/lib/types";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(body?.error ?? `HTTP ${res.status}`),
      { status: res.status, body },
    );
  }
  return body as T;
}

// ── markets ───────────────────────────────────────────────────────────────

export interface ScannerRow extends NormalizedMarket {
  riskGrade: "A" | "B" | "C" | "D";
  tradability: "tradable" | "caution" | "avoid";
  gradeFactors: string[];
  signalScore?: number;
  signalStrategy?: string;
  watchlisted: boolean;
}

export interface MarketsResponse {
  markets: ScannerRow[];
  total: number;
  source: "gamma" | "mock";
  fetchedAt: number;
  categories: { label: string; count: number }[];
}

export interface ScannerFilters {
  q?: string;
  venue?: string;
  tradableOnly?: boolean;
  hideReference?: boolean;
  tag?: string;
  closingHrs?: number;
  minLiquidity?: number;
  minVolume?: number;
  maxSpread?: number;
  priceMin?: number;
  priceMax?: number;
  newOnly?: boolean;
  highMovement?: boolean;
  watchlistOnly?: boolean;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
}

export function useMarkets(filters: ScannerFilters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === "" || v === false) continue;
    params.set(k, v === true ? "1" : String(v));
  }
  return useQuery<MarketsResponse>({
    queryKey: ["markets", params.toString()],
    queryFn: () => json(`/api/markets?${params}`),
    refetchInterval: 15_000,
  });
}

export interface MarketDetail {
  market: ScannerRow;
  yesBook?: OrderBookData;
  noBook?: OrderBookData;
  history: PricePoint[];
  trades: RecentTrade[];
  signals: SignalResult[];
  polymarketUrl?: string;
  watchlisted: boolean;
}

export function useMarketDetail(conditionId?: string, interval = "1w") {
  return useQuery<MarketDetail>({
    queryKey: ["market", conditionId, interval],
    queryFn: () => json(`/api/markets/${conditionId}?interval=${interval}`),
    enabled: Boolean(conditionId),
    refetchInterval: 10_000,
  });
}

// ── portfolio / positions ─────────────────────────────────────────────────

export function usePortfolio(mode: TerminalMode) {
  return useQuery<{ portfolio: PortfolioState; equitySeries: { t: number; equity: number }[] }>({
    queryKey: ["portfolio", mode],
    queryFn: () => json(`/api/portfolio?mode=${mode}`),
    refetchInterval: 15_000,
  });
}

// ── settings ──────────────────────────────────────────────────────────────

export interface SettingsResponse {
  settings: AppSettings;
  liveTradingEnv: boolean;
}

export function useSettings() {
  return useQuery<SettingsResponse>({
    queryKey: ["settings"],
    queryFn: () => json("/api/settings"),
  });
}

export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) =>
      json<SettingsResponse>("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["settings"], data);
      qc.invalidateQueries({ queryKey: ["markets"] });
    },
  });
}

// ── signals ───────────────────────────────────────────────────────────────

export function useSignals(filter: { strategy?: string; status?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (filter.strategy) params.set("strategy", filter.strategy);
  if (filter.status) params.set("status", filter.status);
  params.set("limit", String(filter.limit ?? 100));
  return useQuery<{ signals: SignalResult[] }>({
    queryKey: ["signals", params.toString()],
    queryFn: () => json(`/api/signals?${params}`),
    refetchInterval: 20_000,
  });
}

export function useRunScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => json("/api/signals/scan", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["signals"] });
      qc.invalidateQueries({ queryKey: ["markets"] });
    },
  });
}

// ── orders ────────────────────────────────────────────────────────────────

export function useOrders(mode?: TerminalMode) {
  return useQuery<{ orders: PaperOrder[] }>({
    queryKey: ["orders", mode ?? "all"],
    queryFn: () => json(`/api/orders${mode ? `?mode=${mode}` : ""}`),
    refetchInterval: 10_000,
  });
}

export interface PlaceOrderInput {
  mode: "demo" | "paper";
  conditionId?: string;
  tokenId: string;
  outcome?: string;
  side: "BUY" | "SELL";
  orderType: "limit" | "market";
  price: number;
  size: number;
  winProbability?: number;
  signalScore?: number;
  signalId?: string;
}

export function usePreviewOrder() {
  return useMutation({
    mutationFn: (input: Omit<PlaceOrderInput, "mode"> & { mode: TerminalMode }) =>
      json<{ assessment: RiskAssessment; marketTitle?: string }>(
        "/api/orders/preview",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
  });
}

export function usePlaceOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PlaceOrderInput) =>
      json<{ order?: PaperOrder; assessment: RiskAssessment; rejected: boolean }>(
        "/api/orders",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      json(`/api/orders/${id}/cancel`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });
}

export function useCancelAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: "demo" | "paper") =>
      json("/api/orders/cancel-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });
}

// ── live intents ──────────────────────────────────────────────────────────

export function useIntents() {
  return useQuery<{ intents: LiveOrderIntent[] }>({
    queryKey: ["intents"],
    queryFn: () => json("/api/intents"),
    refetchInterval: 15_000,
  });
}

export function useCreateIntent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<PlaceOrderInput, "mode" | "orderType">) =>
      json<{
        intent: LiveOrderIntent;
        assessment: RiskAssessment;
        gate: { allowed: boolean; reasons: string[] };
      }>("/api/intents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, orderType: "limit" }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["intents"] }),
  });
}

export function useConfirmIntent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmationText }: { id: string; confirmationText?: string }) =>
      json<{ intent: LiveOrderIntent }>(`/api/intents/${id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmationText }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["intents"] }),
  });
}

export function useCancelIntent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      json(`/api/intents/${id}/cancel`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["intents"] }),
  });
}

// ── health / audit / killswitch / backtest ────────────────────────────────

export interface HealthResponse {
  ok: boolean;
  gamma: { ok: boolean; latencyMs?: number };
  clob: { ok: boolean; latencyMs?: number };
  checkedAt: number;
  serverTime: number;
  killSwitch: boolean;
  scannersEnabled: boolean;
  liveTradingEnv: boolean;
  openOrdersCount: number;
}

export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: ["health"],
    queryFn: () => json("/api/health"),
    refetchInterval: 15_000,
  });
}

export function useAudit(filter: { type?: string; severity?: string; q?: string } = {}) {
  const params = new URLSearchParams();
  if (filter.type) params.set("type", filter.type);
  if (filter.severity) params.set("severity", filter.severity);
  if (filter.q) params.set("q", filter.q);
  return useQuery<{ events: AuditEventRecord[] }>({
    queryKey: ["audit", params.toString()],
    queryFn: () => json(`/api/audit?${params}`),
    refetchInterval: 15_000,
  });
}

export function useKillSwitch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (engaged: boolean) =>
      json<{ killSwitch: boolean }>("/api/killswitch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engaged }),
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["health"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

// ── autopilot ─────────────────────────────────────────────────────────────

export function useAutopilot() {
  return useQuery<AutopilotStatus>({
    queryKey: ["autopilot"],
    queryFn: () => json("/api/autopilot"),
    refetchInterval: 10_000,
  });
}

export function useArmAutopilot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { confirmation: string; ttlMinutes: number }) =>
      json<{ ok: boolean; error?: string; armedUntil?: number }>(
        "/api/autopilot/arm",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: ["autopilot"] }),
  });
}

export function useDisarmAutopilot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { resetSession?: boolean } = {}) =>
      json("/api/autopilot/disarm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["autopilot"] }),
  });
}

// ── perf ──────────────────────────────────────────────────────────────────

export interface PerfSnapshot {
  hists: {
    label: string;
    count: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    last: number;
  }[];
  counters: Record<string, number>;
  cacheHitRate?: number;
  uptimeMs: number;
  memoryMb: number;
  auditQueueDepth: number;
  registry: { size: number; updatedAt: number; ageMs: number };
  budgetsMs: { hotP95Target: number; note: string };
}

export function usePerf() {
  return useQuery<PerfSnapshot>({
    queryKey: ["perf"],
    queryFn: () => json("/api/perf"),
    refetchInterval: 5_000,
  });
}

// ── multi-venue ───────────────────────────────────────────────────────────

export function useSources() {
  return useQuery<{
    sources: import("@/lib/types").SourceStatus[];
    referencePrices: import("@/lib/types").ReferencePrice[];
  }>({
    queryKey: ["sources"],
    queryFn: () => json("/api/sources"),
    refetchInterval: 15_000,
  });
}

export function useCrossVenue(status?: string) {
  const params = status ? `?status=${status}` : "";
  return useQuery<{ links: import("@/lib/types").CrossVenueLink[] }>({
    queryKey: ["crossvenue", status ?? "all"],
    queryFn: () => json(`/api/crossvenue${params}`),
    refetchInterval: 30_000,
  });
}

export function useCandles(market?: string, resMin = 60, lookbackSec = 7 * 86_400) {
  return useQuery<{ candles: import("@/lib/types").NormalizedCandle[] }>({
    queryKey: ["candles", market, resMin, lookbackSec],
    queryFn: () => {
      const now = Math.floor(Date.now() / 1000);
      return json(
        `/api/candles?market=${encodeURIComponent(market!)}&res=${resMin}&from=${now - lookbackSec}&to=${now}`,
      );
    },
    enabled: Boolean(market),
    refetchInterval: 30_000,
  });
}

export interface SearchResult {
  kind: "market" | "reference";
  venueId: string;
  id: string;
  ticker?: string;
  title: string;
  tradable: boolean;
  dataClass: string;
  lastUpdated: number;
}

export function useSymbolSearch(q: string) {
  return useQuery<{ results: SearchResult[] }>({
    queryKey: ["search", q],
    queryFn: () => json(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 2,
    staleTime: 10_000,
  });
}

export interface BacktestInput {
  strategyId: "momentum" | "mean_reversion" | "closing_drift";
  conditionIds: string[];
  days: number;
  initialCapital: number;
  positionPct: number;
  holdBars: number;
  targetPct: number;
  stopPct: number;
  feeRateBps: number;
  slippageBps: number;
  spreadAssumption: number;
}

export function useBacktest() {
  return useMutation({
    mutationFn: (input: BacktestInput) =>
      json<{ result: BacktestResult }>("/api/backtest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
  });
}

// ── Alpha Foundry ─────────────────────────────────────────────────────────

export interface FoundryResponse {
  features: (import("@/lib/alpha/types").AlphaFeature & {
    evidence: import("@/lib/alpha/types").FeatureEvidence;
  })[];
  graveyard: (import("@/lib/alpha/types").AlphaFeature & {
    evidence: import("@/lib/alpha/types").FeatureEvidence;
  })[];
  ideas: import("@/lib/alpha/types").ResearchIdea[];
  lastRuns: Record<string, number | undefined>;
  walletIntel: { markets: number; builtAt: number };
  attention: import("@/server/alpha/attention").AttentionTopic[];
  paperPnl: Record<string, { realizedUsd: number; wins: number; losses: number }>;
  researchAgentPrompt: string;
}

export function useFoundry() {
  return useQuery<FoundryResponse>({
    queryKey: ["alpha", "foundry"],
    queryFn: () => json("/api/alpha/foundry"),
    refetchInterval: 30_000,
  });
}

export function useFoundryAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      json<Record<string, unknown>>("/api/alpha/foundry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["alpha"] }),
  });
}

export function useAlphaSources() {
  return useQuery<{ sources: import("@/lib/alpha/types").SourceRecord[] }>({
    queryKey: ["alpha", "sources"],
    queryFn: () => json("/api/alpha/sources"),
    refetchInterval: 60_000,
  });
}

export function useSourceHealthCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      json<{ checked: number }>("/api/alpha/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "health" }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["alpha", "sources"] }),
  });
}

export function useAlphaWallets() {
  return useQuery<{
    wallets: import("@/lib/alpha/types").TrackedWalletRecord[];
    intel: { markets: number; builtAt: number };
  }>({
    queryKey: ["alpha", "wallets"],
    queryFn: () => json("/api/alpha/wallets"),
    refetchInterval: 30_000,
  });
}

export function useWalletAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      json<Record<string, unknown>>("/api/alpha/wallets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["alpha", "wallets"] }),
  });
}

export function useWalletDetail(walletId?: string) {
  return useQuery<{
    wallet: import("@/lib/alpha/types").TrackedWalletRecord;
    trades: import("@/server/alpha/repo").WalletTradeLite[];
    signals: SignalResult[];
  }>({
    queryKey: ["alpha", "wallet", walletId],
    queryFn: () => json(`/api/alpha/wallets/${walletId}`),
    enabled: !!walletId,
  });
}

export function useDisclosures() {
  return useQuery<{ disclosures: import("@/lib/alpha/types").DisclosureRecord[] }>({
    queryKey: ["alpha", "disclosures"],
    queryFn: () => json("/api/alpha/disclosures"),
    refetchInterval: 120_000,
  });
}

// ── Morphish board ─────────────────────────────────────────────────────────

export function useMorphishSummary(mode?: TerminalMode) {
  return useQuery<import("@/server/morphish").MorphishSummary & { cached?: boolean }>({
    queryKey: ["morphish", "summary", mode],
    queryFn: () => json(`/api/morphish/summary${mode ? `?mode=${mode}` : ""}`),
    refetchInterval: 5_000,
  });
}

export function useMorphishTopGem() {
  return useQuery<
    import("@/server/morphish").TopGemPayload & { spark: { t: number; p: number }[] }
  >({
    queryKey: ["morphish", "topgem"],
    queryFn: () => json("/api/morphish/top-gem"),
    refetchInterval: 10_000,
  });
}

export function useMorphishLattice() {
  return useQuery<import("@/server/morphish").LatticePayload>({
    queryKey: ["morphish", "lattice"],
    queryFn: () => json("/api/morphish/probability-lattice"),
    refetchInterval: 15_000,
  });
}

export function useMorphishRidge(selected?: string) {
  return useQuery<import("@/server/morphish").RidgePayload>({
    queryKey: ["morphish", "ridge", selected],
    queryFn: () =>
      json(`/api/morphish/tail-ridge${selected ? `?selected=${encodeURIComponent(selected)}` : ""}`),
    refetchInterval: 20_000,
  });
}

export function useMorphishGraph() {
  return useQuery<import("@/server/morphish").GraphPayload>({
    queryKey: ["morphish", "graph"],
    queryFn: () => json("/api/morphish/relationship-graph"),
    refetchInterval: 20_000,
  });
}

export interface SelectedMarketPayload {
  market: NormalizedMarket;
  book?: OrderBookData;
  signals: SignalResult[];
  crossLinks: import("@/lib/types").CrossVenueLink[];
  walletIntel?: import("@/lib/alpha/types").MarketWalletIntel;
  ruleClarity: number;
  clarityReason: string;
  reasonsFor: string[];
  reasonsAgainst: string[];
}

export function useMorphishSelected(id?: string) {
  return useQuery<SelectedMarketPayload>({
    queryKey: ["morphish", "selected", id],
    queryFn: () => json(`/api/morphish/selected-market/${id}`),
    enabled: !!id,
    refetchInterval: 10_000,
  });
}

export function useMorphishWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { conditionId: string; add: boolean }) =>
      json<{ watchlist: string[] }>("/api/morphish/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}

export interface TradePreviewBody {
  conditionId?: string;
  tokenId: string;
  outcome?: string;
  side: "BUY" | "SELL";
  orderType?: "limit" | "market";
  price: number;
  size: number;
  signalId?: string;
  signalScore?: number;
  winProbability?: number;
}

export function useMorphishPaperPreview() {
  return useMutation({
    mutationFn: (body: TradePreviewBody) =>
      json<{ assessment: RiskAssessment; marketTitle?: string }>(
        "/api/morphish/paper-trade-preview",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      ),
  });
}

export function useMorphishLivePreview() {
  return useMutation({
    mutationFn: (body: TradePreviewBody) =>
      json<{
        assessment: RiskAssessment;
        marketTitle?: string;
        liveGateOpen: boolean;
        liveGateReasons: string[];
        note: string;
      }>("/api/morphish/live-trade-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  });
}
