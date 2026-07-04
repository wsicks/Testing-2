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
