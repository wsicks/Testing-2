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
import { audit } from "./audit";
import { getBook, getMarketByCondition, getMarkets } from "./marketData";
import { computePortfolio } from "./portfolio";
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
}

export interface PlaceOrderResult {
  order?: PaperOrder;
  assessment: RiskAssessment;
  rejected: boolean;
}

async function marketContext(body: PlaceOrderBody) {
  const market = body.conditionId
    ? await getMarketByCondition(body.conditionId)
    : (await getMarkets()).markets.find(
        (m) => m.yesTokenId === body.tokenId || m.noTokenId === body.tokenId,
      );
  const book = await getBook(body.tokenId, market?.midpoint ?? 0.5);
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
  };
}

/** Evaluate a proposal without placing anything (order preview). */
export async function previewTrade(body: PlaceOrderBody): Promise<{
  assessment: RiskAssessment;
  marketTitle?: string;
}> {
  const store = await getStore();
  const settings = await store.getSettings();
  const { market, book } = await marketContext(body);
  const portfolio = await computePortfolio(body.mode);
  const proposal = toProposal(body, market);
  const assessment = evaluateTrade({ proposal, portfolio, settings, market, book });
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
  const portfolio = await computePortfolio(body.mode);
  const proposal = toProposal(body, market);
  const assessment = evaluateTrade({ proposal, portfolio, settings, market, book });

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
    `${body.mode.toUpperCase()} order ${order.id}: ${body.side} ${body.size} ${body.outcome ?? ""} @ ${(body.price * 100).toFixed(1)}c — ${market?.question ?? body.tokenId.slice(0, 12)}`,
    { data: { orderId: order.id, mode: body.mode }, feedType: "order_submitted" },
  );

  // immediate match attempt against the current book
  const { order: matched, fills } = matchOrder(order, book, settings.feeRateBps, now);
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
  return { order, assessment, rejected: false };
}

/** Re-match all open paper/demo orders against fresh books. */
export async function settleOpenOrders(mode: "paper" | "demo"): Promise<number> {
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
  }
  return open.length;
}

// ── live trading gate & intents ────────────────────────────────────────────

export function liveGate(settings: AppSettings): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (process.env.LIVE_TRADING_ENABLED !== "true")
    reasons.push("LIVE_TRADING_ENABLED is not set to true on the server");
  if (!settings.liveModeEnabled)
    reasons.push("Live mode has not been enabled in Settings → API/Wallet");
  if (!settings.termsAcceptedAt)
    reasons.push("Eligibility & terms acknowledgment has not been completed");
  if (settings.killSwitch) reasons.push("Kill switch is engaged");
  return { allowed: reasons.length === 0, reasons };
}

export async function createLiveIntent(body: PlaceOrderBody): Promise<{
  intent: LiveOrderIntent;
  assessment: RiskAssessment;
  gate: { allowed: boolean; reasons: string[] };
}> {
  const store = await getStore();
  const settings = await store.getSettings();
  const gate = liveGate(settings);
  const { market, book } = await marketContext(body);
  const portfolio = await computePortfolio("live");
  const proposal = toProposal(body, market);
  const assessment = evaluateTrade({ proposal, portfolio, settings, market, book });

  const now = Date.now();
  const needsTyped =
    body.price * body.size >= settings.typedConfirmThresholdUsd;
  const intent: LiveOrderIntent = {
    id: genId("int"),
    conditionId: body.conditionId ?? market?.conditionId,
    tokenId: body.tokenId,
    outcome: body.outcome,
    marketTitle: market?.question,
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
 * Confirm a live intent. This is the ONLY path that can submit a live order,
 * and it requires: gate open, risk approval at creation, explicit user call,
 * and typed confirmation text when above the configured threshold.
 */
export async function confirmLiveIntent(
  id: string,
  confirmationText: string | undefined,
): Promise<LiveOrderIntent> {
  const store = await getStore();
  const settings = await store.getSettings();
  const intent = await store.getIntent(id);
  if (!intent) throw new Error("Intent not found");
  if (intent.status !== "previewed" && intent.status !== "approval_required") {
    throw new Error(`Intent is ${intent.status} — cannot confirm`);
  }
  const gate = liveGate(settings);
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
  if (needsTyped && confirmationText?.trim().toUpperCase() !== "CONFIRM") {
    throw new Error(
      `This order is above $${settings.typedConfirmThresholdUsd} — type CONFIRM to approve it`,
    );
  }

  let next: LiveOrderIntent = {
    ...intent,
    status: "confirmed",
    confirmationText: confirmationText?.trim(),
    approvedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.updateIntent(next);
  await audit("user", "live_intent_confirmed", `User CONFIRMED live intent ${id}`, {
    data: { intentId: id },
    feedType: "user_action",
  });

  // hand off to the CLOB adapter (bring-your-own credentials)
  try {
    const { submitLiveOrder } = await import("./liveAdapter");
    const res = await submitLiveOrder(next);
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

export async function cancelIntent(id: string): Promise<LiveOrderIntent | undefined> {
  const store = await getStore();
  const intent = await store.getIntent(id);
  if (!intent) return undefined;
  if (["filled", "canceled", "rejected", "expired"].includes(intent.status))
    return intent;
  const next: LiveOrderIntent = { ...intent, status: "canceled", updatedAt: Date.now() };
  if (intent.clobOrderId) {
    try {
      const { cancelLiveOrder } = await import("./liveAdapter");
      await cancelLiveOrder(intent.clobOrderId);
    } catch (err) {
      next.error = `cancel sent locally; CLOB cancel failed: ${err instanceof Error ? err.message : "unknown"}`;
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
