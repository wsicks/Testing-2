// Execution orchestration: paper orders end-to-end, live order intents with
// hard gating + typed confirmation, kill-switch controls. Every step is audit
// logged. Live orders are NEVER auto-submitted.

import type {
  AppSettings,
  LiveOrderIntent,
  OrderSide,
  OrderType,
  PaperOrder,
  RiskAssessment,
  TerminalMode,
  TradeProposal,
} from "@/lib/types";
import { evaluateTrade } from "@/lib/engine/risk/riskEngine";
import {
  applyFillToPosition,
  matchOrder,
} from "@/lib/engine/execution/paperEngine";
import { genId } from "@/lib/utils";
import { venueForToken } from "@/lib/venues/registry";
import type { VenueId } from "@/lib/types";
import { audit } from "./audit";
import { getExposure, invalidateExposure } from "./hotpath/exposure";
import { getBook, getMarketByCondition, getMarketByToken } from "./marketData";
import { measure, measureSync } from "./perf";
import { getStore } from "./store";

export interface PlaceOrderBody {
  mode: TerminalMode;
  conditionId?: string;
  tokenId: string;
  outcome?: string;
  side: OrderSide;
  orderType: OrderType;
  price: number;
  size: number;
  winProbability?: number;
  signalScore?: number;
  signalId?: string;
  targetPrice?: number;
  stopPrice?: number;
  origin?: "manual" | "autopilot" | "wallet_mimic";
  /** risk-reducing exit of an existing position */
  isExit?: boolean;
}

export interface PlaceOrderResult {
  order?: PaperOrder;
  assessment: RiskAssessment;
  rejected: boolean;
}

async function marketContext(body: PlaceOrderBody) {
  // O(1) registry lookups; the book is served from the in-memory TTL cache.
  // Book failures fail CLOSED: the risk engine blocks on "Spread unavailable".
  const market = body.conditionId
    ? await getMarketByCondition(body.conditionId)
    : await getMarketByToken(body.tokenId);
  const book = await getBook(body.tokenId, market?.midpoint ?? 0.5).catch(
    () => undefined,
  );
  return { market, book };
}

function toProposal(body: PlaceOrderBody, market?: { question?: string; category?: string }): TradeProposal {
  return {
    conditionId: body.conditionId,
    tokenId: body.tokenId,
    outcome: body.outcome,
    marketTitle: market?.question,
    category: market?.category,
    side: body.side,
    orderType: body.orderType,
    price: body.price,
    size: body.size,
    winProbability: body.winProbability,
    signalScore: body.signalScore,
    signalId: body.signalId,
    targetPrice: body.targetPrice,
    stopPrice: body.stopPrice,
    isExit: body.isExit,
  };
}

/**
 * Evaluate a proposal without placing anything (order preview).
 * Hot path: settings, market, book and exposure all come from in-memory
 * caches — no store/DB round-trips once warm. Live previews force a fresh
 * exposure read when the cache exceeds the staleness threshold.
 */
export async function previewTrade(body: PlaceOrderBody): Promise<{
  assessment: RiskAssessment;
  marketTitle?: string;
}> {
  return measure("hot.order_preview", async () => {
    const store = await getStore();
    const settings = await store.getSettings();
    const { market, book } = await marketContext(body);
    // stale exposure blocks until refreshed (never trade on stale state)
    const exposure = await getExposure(body.mode, {
      maxAgeMs: settings.staleDataMaxSecs * 1000,
    });
    const portfolio = exposure.state;
    const proposal = toProposal(body, market);
    const assessment = measureSync("hot.risk_check", () =>
      evaluateTrade({ proposal, portfolio, settings, market, book }),
    );
    return finishPreview(body, market, assessment);
  });
}

async function finishPreview(
  body: PlaceOrderBody,
  market: Awaited<ReturnType<typeof marketContext>>["market"],
  assessment: RiskAssessment,
): Promise<{ assessment: RiskAssessment; marketTitle?: string }> {
  await audit(
    "risk",
    "order_preview",
    `Preview ${body.side} ${body.size} @ ${(body.price * 100).toFixed(1)}c ${market?.question ?? body.tokenId.slice(0, 10)} → ${assessment.approved ? "APPROVED" : "REJECTED"}`,
    {
      severity: assessment.approved ? "info" : "warn",
      data: { reasons: assessment.reasons, mode: body.mode },
      feedType: "order_preview_created",
    },
  );
  return { assessment, marketTitle: market?.question };
}

/** Full paper/demo order lifecycle: risk check → create → match → settle. */
export async function placePaperOrder(body: PlaceOrderBody): Promise<PlaceOrderResult> {
  if (body.mode === "live") {
    throw new Error("placePaperOrder cannot handle live mode — use live intents");
  }
  const store = await getStore();
  const settings = await store.getSettings();
  const { market, book } = await marketContext(body);
  const exposure = await getExposure(body.mode, {
    maxAgeMs: settings.staleDataMaxSecs * 1000,
  });
  const portfolio = exposure.state;
  const proposal = toProposal(body, market);
  const assessment = measureSync("hot.risk_check", () =>
    evaluateTrade({ proposal, portfolio, settings, market, book }),
  );

  // per-venue paper-trading gate — venue flags never leak across venues
  const venue = venueForToken(body.tokenId);
  const venueCfg = settings.venues[venue as Exclude<VenueId, "coingecko">];
  if (body.mode === "paper" && venueCfg && !venueCfg.paperTrading && !body.isExit) {
    assessment.approved = false;
    const reason = `BLOCKED — venue_paper_disabled: paper trading for ${venue} is disabled in Settings`;
    assessment.reasons.unshift(reason);
    assessment.checks.unshift({
      name: "venue_paper_enabled",
      passed: false,
      detail: reason,
      severity: "block",
    });
  }

  if (!assessment.approved) {
    await audit(
      "risk",
      "order_rejected",
      `REJECTED ${body.side} ${body.size} @ ${(body.price * 100).toFixed(1)}c — ${assessment.reasons[0] ?? "risk checks failed"}`,
      {
        severity: "warn",
        data: { reasons: assessment.reasons, mode: body.mode },
        feedType: "risk_check_failed",
      },
    );
    return { assessment, rejected: true };
  }

  const now = Date.now();
  let order: PaperOrder = {
    id: genId("ord"),
    mode: body.mode as "paper" | "demo",
    conditionId: body.conditionId ?? market?.conditionId,
    tokenId: body.tokenId,
    outcome: body.outcome,
    marketTitle: market?.question,
    category: market?.category,
    origin: body.origin ?? "manual",
    side: body.side,
    orderType: body.orderType,
    price: body.price,
    size: body.size,
    filledSize: 0,
    status: "created",
    signalId: body.signalId,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + settings.orderExpirationMin * 60_000,
  };
  await store.createOrder(order);
  await audit(
    "execution",
    "order_submitted",
    `${body.mode.toUpperCase()}${body.origin === "autopilot" ? "/AUTOPILOT" : ""} order ${order.id}: ${body.side} ${body.size} ${body.outcome ?? ""} @ ${(body.price * 100).toFixed(1)}c — ${market?.question ?? body.tokenId.slice(0, 12)}`,
    { data: { orderId: order.id, mode: body.mode, origin: body.origin ?? "manual" }, feedType: "order_submitted" },
  );

  // immediate match attempt against the current book (no book → rest open;
  // settlement retries once the venue book is reachable again)
  const { order: matched, fills } = book
    ? matchOrder(order, book, settings.feeRateBps, now)
    : { order, fills: [] };
  order = matched;
  if (order.status === "created") order = { ...order, status: "open" };

  for (const fill of fills) {
    const existing = await store.getPosition(fill.tokenId, body.mode);
    const upd = applyFillToPosition(existing, fill);
    fill.realizedPnlDelta =
      fill.side === "SELL" ? Number(upd.realizedPnlDelta.toFixed(2)) : undefined;
    await store.upsertPosition(upd.position);
    await store.adjustCash(body.mode, upd.cashDelta);
  }
  if (fills.length) {
    await store.addFills(fills);
    await audit(
      "execution",
      "order_filled",
      `Order ${order.id} ${order.status === "filled" ? "FILLED" : "PARTIALLY FILLED"}: ${order.filledSize}/${order.size} @ avg ${((order.avgFillPrice ?? 0) * 100).toFixed(1)}c`,
      { data: { orderId: order.id, fills: fills.length }, feedType: "order_filled" },
    );
  }
  await store.updateOrder(order);
  if (fills.length) invalidateExposure(body.mode); // async refresh after fills
  return { order, assessment, rejected: false };
}

// Settlement must never run concurrently for the same mode: two overlapping
// runs would read the same open-order snapshot and double-apply fills. Calls
// are serialized through a per-mode promise chain (single-process mutex).
const settleChains = new Map<string, Promise<number>>();

export function settleOpenOrders(mode: "paper" | "demo"): Promise<number> {
  const prev = settleChains.get(mode) ?? Promise.resolve(0);
  const next = prev.then(
    () => settleOpenOrdersUnsafe(mode),
    () => settleOpenOrdersUnsafe(mode),
  );
  settleChains.set(mode, next);
  return next;
}

/** Re-match all open paper/demo orders against fresh books. */
async function settleOpenOrdersUnsafe(mode: "paper" | "demo"): Promise<number> {
  const store = await getStore();
  const settings = await store.getSettings();
  const open = await store.listOrders(mode, ["open", "partially_filled"]);
  let touched = 0;
  for (const o of open) {
    const book = await getBook(o.tokenId);
    const { order: next, fills } = matchOrder(o, book, settings.feeRateBps);
    if (next.status === o.status && fills.length === 0) continue;
    touched += 1;
    for (const fill of fills) {
      const existing = await store.getPosition(fill.tokenId, mode);
      const upd = applyFillToPosition(existing, fill);
      fill.realizedPnlDelta =
        fill.side === "SELL" ? Number(upd.realizedPnlDelta.toFixed(2)) : undefined;
      await store.upsertPosition(upd.position);
      await store.adjustCash(mode, upd.cashDelta);
    }
    if (fills.length) {
      await store.addFills(fills);
      await audit(
        "execution",
        "order_filled",
        `Order ${next.id} matched on refresh: ${next.filledSize}/${next.size} filled`,
        { data: { orderId: next.id }, feedType: "order_filled" },
      );
    }
    if (next.status === "expired") {
      await audit("execution", "order_expired", `Order ${next.id} expired unfilled`, {
        severity: "warn",
        data: { orderId: next.id },
      });
    }
    await store.updateOrder(next);
  }
  if (touched > 0) invalidateExposure(mode);
  return touched;
}

export async function cancelOrder(id: string, actor: "user" | "system" = "user"): Promise<PaperOrder | undefined> {
  const store = await getStore();
  const order = await store.getOrder(id);
  if (!order) return undefined;
  if (!["created", "open", "partially_filled"].includes(order.status)) return order;
  const next: PaperOrder = { ...order, status: "canceled", updatedAt: Date.now() };
  await store.updateOrder(next);
  await audit(actor === "user" ? "user" : "system", "order_canceled", `Order ${id} canceled`, {
    data: { orderId: id },
    feedType: "order_canceled",
  });
  return next;
}

export async function cancelAllOrders(mode: "paper" | "demo"): Promise<number> {
  const store = await getStore();
  const open = await store.listOrders(mode, ["created", "open", "partially_filled"]);
  for (const o of open) {
    await store.updateOrder({ ...o, status: "canceled", updatedAt: Date.now() });
  }
  if (open.length) {
    await audit("user", "cancel_all", `Canceled ${open.length} open ${mode} order(s)`, {
      data: { count: open.length },
      feedType: "order_canceled",
    });
    invalidateExposure(mode);
  }
  return open.length;
}

// ── live trading gate & intents ────────────────────────────────────────────

export function liveGate(
  settings: AppSettings,
  venue: VenueId = "polymarket",
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (process.env.LIVE_TRADING_ENABLED !== "true")
    reasons.push("LIVE_TRADING_ENABLED is not set to true on the server");
  if (!settings.liveModeEnabled)
    reasons.push("Live mode has not been enabled in Settings → API/Wallet");
  if (!settings.termsAcceptedAt)
    reasons.push("Eligibility & terms acknowledgment has not been completed");
  if (settings.killSwitch) reasons.push("Kill switch is engaged");
  // per-venue live flag — enabling one venue NEVER enables another
  if (venue === "coingecko") {
    reasons.push("CoinGecko is a reference-only source and can never trade");
  } else {
    const vc = settings.venues[venue];
    if (!vc?.liveEnabled)
      reasons.push(`Live trading for ${venue} has not been enabled (per-venue flag in Settings)`);
  }
  return { allowed: reasons.length === 0, reasons };
}

export async function createLiveIntent(body: PlaceOrderBody): Promise<{
  intent: LiveOrderIntent;
  assessment: RiskAssessment;
  gate: { allowed: boolean; reasons: string[] };
}> {
  const store = await getStore();
  const settings = await store.getSettings();
  const gate = liveGate(settings, venueForToken(body.tokenId));
  const { market, book } = await marketContext(body);
  // live path: never evaluate on stale exposure — block until refreshed
  const exposure = await getExposure("live", {
    maxAgeMs: settings.staleDataMaxSecs * 1000,
  });
  const proposal = toProposal(body, market);
  const assessment = measureSync("hot.risk_check", () =>
    evaluateTrade({ proposal, portfolio: exposure.state, settings, market, book }),
  );

  const now = Date.now();
  const needsTyped =
    body.price * body.size >= settings.typedConfirmThresholdUsd;
  const intent: LiveOrderIntent = {
    id: genId("int"),
    conditionId: body.conditionId ?? market?.conditionId,
    tokenId: body.tokenId,
    outcome: body.outcome,
    marketTitle: market?.question,
    origin: body.origin ?? "manual",
    side: body.side,
    orderType: body.orderType,
    price: body.price,
    size: body.size,
    filledSize: 0,
    status:
      !gate.allowed || !assessment.approved
        ? "rejected"
        : needsTyped
          ? "approval_required"
          : "previewed",
    error: !gate.allowed
      ? gate.reasons.join("; ")
      : !assessment.approved
        ? assessment.reasons.filter((r) => r.startsWith("BLOCKED")).join("; ")
        : undefined,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + settings.orderExpirationMin * 60_000,
  };
  await store.createIntent(intent);
  await audit(
    "execution",
    "live_intent_created",
    `LIVE intent ${intent.id} (${intent.status}): ${body.side} ${body.size} @ ${(body.price * 100).toFixed(1)}c — ${market?.question ?? body.tokenId.slice(0, 12)}`,
    {
      severity: intent.status === "rejected" ? "warn" : "info",
      data: { intentId: intent.id, gate: gate.reasons, approved: assessment.approved },
      feedType: "order_preview_created",
    },
  );
  return { intent, assessment, gate };
}

/**
 * Confirm a live intent. This is the ONLY path that can submit a live order.
 * Manual path: explicit user call + typed confirmation above the threshold.
 * Autopilot path (`opts.autopilotArmed`): permitted only while the user has
 * explicitly ARMED live autopilot — the arming ritual (typed phrase + TTL +
 * budget) is the standing confirmation; the audit trail records it as such.
 */
export async function confirmLiveIntent(
  id: string,
  confirmationText: string | undefined,
  opts: { autopilotArmed?: boolean } = {},
): Promise<LiveOrderIntent> {
  const store = await getStore();
  const settings = await store.getSettings();
  const intent = await store.getIntent(id);
  if (!intent) throw new Error("Intent not found");
  if (intent.status !== "previewed" && intent.status !== "approval_required") {
    throw new Error(`Intent is ${intent.status} — cannot confirm`);
  }
  const gate = liveGate(settings, venueForToken(intent.tokenId));
  if (!gate.allowed) {
    const next: LiveOrderIntent = {
      ...intent,
      status: "rejected",
      error: gate.reasons.join("; "),
      updatedAt: Date.now(),
    };
    await store.updateIntent(next);
    await audit("risk", "live_intent_rejected", `LIVE intent ${id} rejected at confirm: ${gate.reasons.join("; ")}`, {
      severity: "warn",
      feedType: "risk_check_failed",
    });
    return next;
  }
  const needsTyped =
    intent.price * intent.size >= settings.typedConfirmThresholdUsd;
  if (
    !opts.autopilotArmed &&
    needsTyped &&
    confirmationText?.trim().toUpperCase() !== "CONFIRM"
  ) {
    throw new Error(
      `This order is above $${settings.typedConfirmThresholdUsd} — type CONFIRM to approve it`,
    );
  }

  let next: LiveOrderIntent = {
    ...intent,
    status: "confirmed",
    confirmationText: opts.autopilotArmed
      ? "auto-confirmed under armed autopilot session"
      : confirmationText?.trim(),
    approvedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.updateIntent(next);
  await audit(
    opts.autopilotArmed ? "execution" : "user",
    "live_intent_confirmed",
    opts.autopilotArmed
      ? `Intent ${id} auto-confirmed under ARMED live autopilot (user pre-authorized this session)`
      : `User CONFIRMED live intent ${id}`,
    { data: { intentId: id, autopilot: Boolean(opts.autopilotArmed) }, feedType: "user_action" },
  );

  // hand off to the OWNING venue's execution adapter — execution logic is
  // never shared across venues
  try {
    const venue = venueForToken(next.tokenId);
    const res = await submitByVenue(venue, next);
    next = {
      ...next,
      status: "submitted",
      clobOrderId: res.orderId,
      updatedAt: Date.now(),
    };
    await store.updateIntent(next);
    await audit("execution", "live_order_submitted", `LIVE order submitted to CLOB: ${res.orderId}`, {
      data: { intentId: id, clobOrderId: res.orderId },
      feedType: "order_submitted",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown adapter error";
    next = { ...next, status: "rejected", error: message, updatedAt: Date.now() };
    await store.updateIntent(next);
    await audit("execution", "live_order_error", `LIVE submission failed: ${message}`, {
      severity: "error",
      data: { intentId: id },
      feedType: "api_error",
    });
  }
  return next;
}

async function submitByVenue(
  venue: VenueId,
  intent: LiveOrderIntent,
): Promise<{ orderId: string }> {
  switch (venue) {
    case "polymarket": {
      const { submitLiveOrder } = await import("./liveAdapter");
      return submitLiveOrder(intent);
    }
    case "kalshi": {
      const { submitKalshiOrder } = await import("./kalshiLive");
      return submitKalshiOrder(intent);
    }
    case "coinbase": {
      const { submitCoinbaseOrder } = await import("./coinbaseLive");
      return submitCoinbaseOrder(intent);
    }
    default:
      throw new Error(`venue ${venue} cannot execute orders`);
  }
}

async function cancelByVenue(venue: VenueId, upstreamId: string): Promise<void> {
  switch (venue) {
    case "polymarket": {
      const { cancelLiveOrder } = await import("./liveAdapter");
      return cancelLiveOrder(upstreamId);
    }
    case "kalshi": {
      const { cancelKalshiOrder } = await import("./kalshiLive");
      return cancelKalshiOrder(upstreamId);
    }
    case "coinbase": {
      const { cancelCoinbaseOrder } = await import("./coinbaseLive");
      return cancelCoinbaseOrder(upstreamId);
    }
    default:
      return;
  }
}

export async function cancelIntent(id: string): Promise<LiveOrderIntent | undefined> {
  const store = await getStore();
  const intent = await store.getIntent(id);
  if (!intent) return undefined;
  if (["filled", "canceled", "rejected", "expired"].includes(intent.status))
    return intent;
  const next: LiveOrderIntent = { ...intent, status: "canceled", updatedAt: Date.now() };
  if (intent.clobOrderId) {
    try {
      await cancelByVenue(venueForToken(intent.tokenId), intent.clobOrderId);
    } catch (err) {
      next.error = `cancel sent locally; venue cancel failed: ${err instanceof Error ? err.message : "unknown"}`;
    }
  }
  await store.updateIntent(next);
  await audit("user", "live_intent_canceled", `Live intent ${id} canceled`, {
    data: { intentId: id },
    feedType: "order_canceled",
  });
  return next;
}

// ── kill switch ──────────────────────────────────────────────────────────────

export async function setKillSwitch(engaged: boolean): Promise<void> {
  const store = await getStore();
  await store.patchSettings({ killSwitch: engaged, ...(engaged ? { scannersEnabled: false } : {}) });
  if (engaged) {
    const canceledPaper = await cancelAllOrders("paper");
    const canceledDemo = await cancelAllOrders("demo");
    const intents = await store.listIntents(["previewed", "approval_required", "confirmed", "submitted", "open"]);
    for (const i of intents) await cancelIntent(i.id);
    await audit(
      "user",
      "kill_switch",
      `KILL SWITCH ENGAGED — trading disabled, ${canceledPaper + canceledDemo} paper order(s) and ${intents.length} live intent(s) canceled, scanners stopped`,
      { severity: "warn", feedType: "kill_switch" },
    );
  } else {
    await audit("user", "kill_switch", "Kill switch disengaged — trading re-enabled manually", {
      feedType: "kill_switch",
    });
  }
}
