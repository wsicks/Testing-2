// Autopilot — the autonomous trading engine.
//
// Runs on every scanner tick: manages exits first (always), then trips
// breakers, then evaluates entries through the policy → risk-engine →
// execution pipeline. Learns strategy quality from REALIZED exits via a
// Thompson-sampling bandit. Every decision (including every skip) is recorded
// with its reason and fanned out to the live feed + audit log.
//
// Safety envelope, in order of authority:
//   kill switch  → nothing runs
//   mode=off     → nothing runs
//   mode=observe → decisions logged, nothing executed
//   mode=paper   → fully automated simulated trading
//   mode=live    → requires the live gate AND a time-boxed ARM ritual;
//                  breaker/expiry auto-disarms. Arming never survives restart.

import { mulberry32 } from "@/lib/rng";
import { genId } from "@/lib/utils";
import type {
  AutopilotDecision,
  AutopilotSession,
  AutopilotStatus,
  BanditArm,
  ManagedPosition,
  NormalizedMarket,
  SignalResult,
} from "@/lib/types";
import {
  emptyBandit,
  sampleArms,
  updateBandit,
  type BanditState,
} from "@/lib/engine/autopilot/bandit";
import { decideEntries } from "@/lib/engine/autopilot/policy";
import { evaluateExit } from "@/lib/engine/autopilot/exits";
import { classifyRegime, type Regime } from "@/lib/engine/micro/regime";
import { strategyHitRates } from "@/lib/alpha/hitRate";
import { allOutcomes } from "./alpha/outcomes";
import { audit } from "./audit";
import { publishFeed } from "./events";
import {
  cancelOrder,
  confirmLiveIntent,
  createLiveIntent,
  liveGate,
  placePaperOrder,
} from "./execution";
import { getExposure } from "./hotpath/exposure";
import { getBook, getHistory, getMarkets, priceLookup } from "./marketData";
import { getStore } from "./store";

const KV_BANDIT = "autopilot:bandit";
const KV_MANAGED = "autopilot:managed";
const KV_DECISIONS = "autopilot:decisions";
const ARM_PHRASE = "ARM LIVE AUTOPILOT";

interface ApGlobal {
  session: AutopilotSession;
  decisions: AutopilotDecision[];
  entryTs: number[];
  lastBandit: BanditArm[];
  running: boolean;
  loaded: boolean;
  rand: () => number;
}

const g = globalThis as unknown as { __pqAutopilot?: ApGlobal };

function state(): ApGlobal {
  if (!g.__pqAutopilot) {
    g.__pqAutopilot = {
      session: {
        trades: 0,
        notionalUsd: 0,
        realizedPnlUsd: 0,
        tradesLastHour: 0,
        breakerTripped: false,
      },
      decisions: [],
      entryTs: [],
      lastBandit: [],
      running: false,
      loaded: false,
      rand: mulberry32(Date.now() & 0xffffffff),
    };
  }
  return g.__pqAutopilot;
}

async function loadPersisted(): Promise<void> {
  const s = state();
  if (s.loaded) return;
  const store = await getStore();
  const decisions = await store.getKV<AutopilotDecision[]>(KV_DECISIONS);
  if (decisions) s.decisions = decisions;
  s.loaded = true;
}

function record(d: Omit<AutopilotDecision, "id" | "ts"> & { ts?: number }): AutopilotDecision {
  const s = state();
  const dec: AutopilotDecision = { id: genId("apd"), ts: d.ts ?? Date.now(), ...d };
  s.decisions.unshift(dec);
  if (s.decisions.length > 150) s.decisions.length = 150;
  return dec;
}

async function persistDecisions(): Promise<void> {
  const store = await getStore();
  await store.setKV(KV_DECISIONS, state().decisions.slice(0, 60));
}

async function getBandit(): Promise<BanditState> {
  const store = await getStore();
  const existing = await store.getKV<BanditState>(KV_BANDIT);
  if (existing) return existing;
  const settings = await store.getSettings();
  return emptyBandit(settings.autopilot.enabledStrategies);
}

async function getManaged(): Promise<ManagedPosition[]> {
  const store = await getStore();
  return (await store.getKV<ManagedPosition[]>(KV_MANAGED)) ?? [];
}

async function setManaged(list: ManagedPosition[]): Promise<void> {
  const store = await getStore();
  await store.setKV(KV_MANAGED, list);
}

// ── arming ────────────────────────────────────────────────────────────────────

export async function armLiveAutopilot(
  confirmation: string,
  ttlMinutes: number,
): Promise<{ ok: boolean; error?: string; armedUntil?: number }> {
  const store = await getStore();
  const settings = await store.getSettings();
  if (settings.autopilot.mode !== "live") {
    return { ok: false, error: "Autopilot mode must be set to live before arming" };
  }
  const gate = liveGate(settings);
  if (!gate.allowed) {
    return { ok: false, error: `Live gate closed: ${gate.reasons.join("; ")}` };
  }
  // "type exactly" means exactly — no case folding on an arming ritual
  if (confirmation.trim() !== ARM_PHRASE) {
    return { ok: false, error: `Type exactly "${ARM_PHRASE}" to arm` };
  }
  const ttl = Math.min(Math.max(ttlMinutes, 5), 8 * 60); // 5 min – 8 h
  const s = state();
  s.session.armedUntil = Date.now() + ttl * 60_000;
  s.session.breakerTripped = false;
  s.session.breakerReason = undefined;
  record({
    kind: "arm",
    reason: `LIVE autopilot ARMED for ${ttl}m — session budget $${settings.autopilot.maxSessionNotionalUsd}, breaker at -$${settings.autopilot.sessionMaxLossUsd}`,
  });
  await audit("user", "autopilot_armed", `LIVE autopilot ARMED for ${ttl} minutes by explicit user confirmation`, {
    severity: "warn",
    feedType: "autopilot_armed",
    data: { ttlMinutes: ttl, armedUntil: s.session.armedUntil },
  });
  await persistDecisions();
  return { ok: true, armedUntil: s.session.armedUntil };
}

export async function disarmAutopilot(reason: string, actor: "user" | "system" = "user"): Promise<void> {
  const s = state();
  if (s.session.armedUntil === undefined && actor === "system") return;
  s.session.armedUntil = undefined;
  record({ kind: "disarm", reason });
  await audit(actor, "autopilot_disarmed", `Live autopilot disarmed: ${reason}`, {
    feedType: "autopilot_disarmed",
  });
  await persistDecisions();
}

function isArmed(): boolean {
  const s = state();
  return s.session.armedUntil !== undefined && Date.now() < s.session.armedUntil;
}

// ── status ────────────────────────────────────────────────────────────────────

export async function getAutopilotStatus(): Promise<AutopilotStatus> {
  await loadPersisted();
  const s = state();
  const store = await getStore();
  const settings = await store.getSettings();
  const gate = liveGate(settings);
  const managed = await getManaged();
  s.session.tradesLastHour = s.entryTs.filter((t) => Date.now() - t < 3_600_000).length;
  // arming expiry surfaced lazily
  if (s.session.armedUntil !== undefined && Date.now() >= s.session.armedUntil) {
    await disarmAutopilot("arming TTL expired", "system");
  }
  let bandit = s.lastBandit;
  if (!bandit.length) {
    const bs = await getBandit();
    bandit = sampleArms(bs, s.rand);
  }
  return {
    config: settings.autopilot,
    session: { ...s.session },
    bandit,
    decisions: s.decisions.slice(0, 60),
    managedPositions: managed.length,
    liveGateOpen: gate.allowed,
    liveGateReasons: gate.reasons,
  };
}

// ── the tick ─────────────────────────────────────────────────────────────────

export async function autopilotTick(): Promise<{ ran: boolean; entries: number; exits: number }> {
  await loadPersisted();
  const s = state();
  if (s.running) return { ran: false, entries: 0, exits: 0 };
  s.running = true;
  try {
    const store = await getStore();
    const settings = await store.getSettings();
    const config = settings.autopilot;
    if (settings.killSwitch) {
      return { ran: false, entries: 0, exits: 0 };
    }
    // exits are risk-reducing and run even with autopilot OFF — managed lots
    // (e.g. wallet-mimic paper tests) must never be orphaned. Entries stay
    // strictly mode-gated below.
    const entriesEnabled = config.mode !== "off";
    if (!entriesEnabled && (await getManaged()).length === 0) {
      return { ran: false, entries: 0, exits: 0 };
    }
    if (entriesEnabled && !s.session.startedAt) s.session.startedAt = Date.now();
    s.session.lastTickAt = Date.now();

    // live arming expiry
    if (config.mode === "live" && s.session.armedUntil !== undefined && !isArmed()) {
      await disarmAutopilot("arming TTL expired", "system");
    }

    const { markets } = await getMarkets();
    const marketMap = new Map(markets.map((m) => [m.conditionId, m]));
    const marks = await priceLookup();

    // ── 1) exits first — risk-reducing, run even when the breaker is tripped ─
    let exits = 0;
    let managed = await getManaged();
    const stillManaged: ManagedPosition[] = [];
    for (const pos of managed) {
      const mark = marks.get(pos.tokenId);
      const decision = evaluateExit(pos, mark, config);
      pos.peakPrice = decision.peakPrice;
      if (decision.action === "hold") {
        stillManaged.push(pos);
        continue;
      }
      const isPartial = decision.action === "partial_exit";
      const executed = await executeExit(
        pos,
        decision.reason ?? "exit",
        decision.detail,
        config.mode,
        isPartial ? decision.sellSize : undefined,
      );
      if (executed.closedSize > 0) {
        exits += 1;
        s.session.realizedPnlUsd = Number(
          (s.session.realizedPnlUsd + executed.pnlUsd).toFixed(2),
        );
        // bandit learns only from REALIZED outcomes — paper exits have a
        // measured fill PnL; a dispatched live exit's outcome is unknown
        // (no fill tracking), and recording it as a $0 "loss" would
        // fabricate negative evidence against promoted strategies
        if (pos.mode === "paper") {
          const bs = await getBandit();
          updateBandit(bs, pos.strategy, executed.pnlUsd > 0, executed.pnlUsd);
          await store.setKV(KV_BANDIT, bs);
        }
      }
      if (executed.remaining > 0) {
        stillManaged.push({
          ...pos,
          size: executed.remaining,
          // a filled plan tranche never re-fires; a blocked one retries
          partialDone: pos.partialDone || (isPartial && executed.closedSize > 0),
        });
      }
    }
    managed = stillManaged;
    await setManaged(managed);

    // ── 2) circuit breaker ────────────────────────────────────────────────
    if (
      !s.session.breakerTripped &&
      s.session.realizedPnlUsd <= -config.sessionMaxLossUsd
    ) {
      s.session.breakerTripped = true;
      s.session.breakerReason = `session loss $${Math.abs(s.session.realizedPnlUsd).toFixed(2)} ≥ breaker $${config.sessionMaxLossUsd}`;
      record({ kind: "halt", reason: `CIRCUIT BREAKER: ${s.session.breakerReason} — entries halted, exits continue` });
      await audit("risk", "autopilot_breaker", `Autopilot circuit breaker tripped: ${s.session.breakerReason}`, {
        severity: "error",
        feedType: "autopilot_halt",
      });
      if (config.mode === "live") await disarmAutopilot("circuit breaker tripped", "system");
    }

    // ── 3) entries — strictly mode-gated ───────────────────────────────────
    let entries = 0;
    if (entriesEnabled && !s.session.breakerTripped) {
      const recentSignals = (await store.listSignals({ limit: 150 })).filter(
        (x) => Date.now() - x.createdAt < 12 * 60_000,
      );
      const regimes = await buildRegimes(recentSignals, marketMap);
      const bs = await getBandit();
      const bandit = sampleArms(bs, s.rand);
      s.lastBandit = bandit;
      s.session.tradesLastHour = s.entryTs.filter((t) => Date.now() - t < 3_600_000).length;

      const exposure = await getExposure(config.mode === "live" ? "live" : "paper");
      // hit-rate governor input: measured 1h hit rates from the outcome
      // archive (in-memory read, ≤2000 rows) — the policy blocks entries from
      // strategies with a proven-bad win rate and boosts proven-good ones
      const hitRates = new Map(
        strategyHitRates(await allOutcomes()).map((h) => [h.strategy, h]),
      );
      const { candidates, skips } = decideEntries({
        signals: recentSignals,
        markets: marketMap,
        regimes,
        portfolio: exposure.state,
        settings,
        config,
        bandit,
        managed,
        session: {
          trades: s.session.trades,
          notionalUsd: s.session.notionalUsd,
          tradesLastHour: s.session.tradesLastHour,
        },
        hitRates,
        now: Date.now(),
      });
      // keep skip noise low: record at most 6 distinct skips per tick
      for (const sk of skips.slice(0, 6)) {
        s.decisions.unshift(sk);
        if (s.decisions.length > 150) s.decisions.length = 150;
      }

      for (const cand of candidates) {
        const endDate = cand.proposal.conditionId
          ? marketMap.get(cand.proposal.conditionId)?.endDate
          : undefined;
        const executed = await executeEntry(cand.proposal, cand.strategy, cand.signal, config.mode, endDate);
        if (executed.ok) {
          entries += 1;
          s.entryTs.push(Date.now());
          s.session.trades += 1;
          // ledger accrues what actually DEPLOYED (paper IOC may fill less
          // than proposed); live intents accrue the proposal since fills
          // aren't tracked — the conservative direction for a budget
          s.session.notionalUsd = Number(
            (s.session.notionalUsd + executed.filledNotionalUsd).toFixed(2),
          );
          // refresh exposure synchronously so the NEXT candidate's risk
          // check sees this entry's cash/exposure, not the pre-fill snapshot
          await getExposure(config.mode === "live" ? "live" : "paper", {
            forceFresh: true,
          }).catch(() => {});
        }
      }
      s.entryTs = s.entryTs.filter((t) => Date.now() - t < 3_600_000);
    }

    await persistDecisions();
    return { ran: true, entries, exits };
  } finally {
    state().running = false;
  }
}

async function buildRegimes(
  signals: SignalResult[],
  markets: Map<string, NormalizedMarket>,
): Promise<Map<string, Regime>> {
  const regimes = new Map<string, Regime>();
  const wanted = [...new Set(signals.map((x) => x.conditionId).filter(Boolean))].slice(0, 20) as string[];
  for (const cid of wanted) {
    const m = markets.get(cid);
    if (!m?.yesTokenId) continue;
    try {
      const hist = await getHistory(m.yesTokenId, "1d", 30);
      regimes.set(cid, classifyRegime(hist).regime);
    } catch {
      regimes.set(cid, "unknown");
    }
  }
  return regimes;
}

async function executeEntry(
  proposal: import("@/lib/types").TradeProposal,
  strategy: string,
  signal: SignalResult,
  mode: "observe" | "paper" | "live" | "off",
  endDate?: string,
): Promise<{ ok: boolean; filledNotionalUsd: number }> {
  const base = {
    conditionId: proposal.conditionId,
    tokenId: proposal.tokenId,
    outcome: proposal.outcome,
    side: proposal.side,
    orderType: proposal.orderType,
    price: proposal.price,
    size: proposal.size,
    winProbability: proposal.winProbability,
    signalScore: proposal.signalScore,
    signalId: proposal.signalId,
    origin: "autopilot" as const,
  };

  if (mode === "observe") {
    record({
      kind: "entry",
      strategy,
      conditionId: proposal.conditionId,
      marketQuestion: proposal.marketTitle,
      side: proposal.side,
      price: proposal.price,
      size: proposal.size,
      approved: undefined,
      reason: `OBSERVE — would ${proposal.side} ${proposal.size} ${proposal.outcome} @ ${(proposal.price * 100).toFixed(1)}c (${strategy}, score ${signal.score})`,
    });
    publishFeed("autopilot_skip", `[observe] would enter ${proposal.marketTitle?.slice(0, 50)} ${proposal.outcome} @ ${(proposal.price * 100).toFixed(1)}c`, {});
    return { ok: false, filledNotionalUsd: 0 };
  }

  if (mode === "live") {
    if (!isArmed()) {
      record({
        kind: "skip",
        strategy,
        conditionId: proposal.conditionId,
        marketQuestion: proposal.marketTitle,
        reason: "live autopilot not ARMED — entry withheld",
      });
      return { ok: false, filledNotionalUsd: 0 };
    }
    // Alpha Foundry gate: only PROMOTED features (prosecutor pass + human
    // approval) may ever route to live — experimental/paper strategies are
    // structurally incapable of reaching this path
    const { liveEligibleStrategies } = await import("./alpha/foundry");
    const eligible = await liveEligibleStrategies();
    if (!eligible.has(strategy)) {
      record({
        kind: "skip",
        strategy,
        conditionId: proposal.conditionId,
        marketQuestion: proposal.marketTitle,
        reason: `strategy '${strategy}' is not PROMOTED in the Alpha Foundry — experimental signals never trade live`,
      });
      return { ok: false, filledNotionalUsd: 0 };
    }
    const { intent, assessment } = await createLiveIntent({ ...base, mode: "live" });
    if (intent.status === "rejected") {
      record({
        kind: "skip",
        strategy,
        conditionId: proposal.conditionId,
        marketQuestion: proposal.marketTitle,
        approved: false,
        reason: `live intent rejected: ${intent.error ?? assessment.reasons[0] ?? "risk"}`,
      });
      return { ok: false, filledNotionalUsd: 0 };
    }
    const confirmed = await confirmLiveIntent(intent.id, undefined, { autopilotArmed: true });
    record({
      kind: "entry",
      strategy,
      conditionId: proposal.conditionId,
      marketQuestion: proposal.marketTitle,
      side: proposal.side,
      price: proposal.price,
      size: proposal.size,
      orderId: confirmed.id,
      approved: confirmed.status !== "rejected",
      reason: `LIVE ${confirmed.status}: ${strategy} score ${signal.score}${confirmed.error ? ` — ${confirmed.error}` : ""}`,
    });
    publishFeed("autopilot_entry", `[live] ${proposal.side} ${proposal.size} ${proposal.outcome} @ ${(proposal.price * 100).toFixed(1)}c — ${proposal.marketTitle?.slice(0, 45)} (${confirmed.status})`, {
      severity: confirmed.status === "rejected" ? "warn" : "info",
    });
    // live fills are not tracked automatically; the lot is managed only if
    // the CLOB accepted the order
    if (confirmed.status === "submitted") {
      const managed = await getManaged();
      const livePlanMeta = signal.meta?.exitPlan as
        | { partialExitAt?: number; fullExitAt?: number }
        | undefined;
      managed.push({
        tokenId: proposal.tokenId,
        conditionId: proposal.conditionId,
        marketQuestion: proposal.marketTitle,
        outcome: proposal.outcome,
        strategy,
        mode: "live",
        entryPrice: proposal.price,
        size: proposal.size,
        openedAt: Date.now(),
        peakPrice: proposal.price,
        endDate,
        exitPlan:
          typeof livePlanMeta?.partialExitAt === "number" && typeof livePlanMeta?.fullExitAt === "number"
            ? { partialAt: livePlanMeta.partialExitAt, fullAt: livePlanMeta.fullExitAt }
            : undefined,
      });
      await setManaged(managed);
      // live fills aren't tracked — accrue the proposal notional (conservative)
      return { ok: true, filledNotionalUsd: proposal.price * proposal.size };
    }
    return { ok: false, filledNotionalUsd: 0 };
  }

  // paper: place, then enforce IOC semantics — manage only what filled now
  const res = await placePaperOrder({ ...base, mode: "paper" });
  if (res.rejected || !res.order) {
    record({
      kind: "skip",
      strategy,
      conditionId: proposal.conditionId,
      marketQuestion: proposal.marketTitle,
      approved: false,
      reason: `risk engine rejected: ${res.assessment.reasons.find((r) => r.startsWith("BLOCKED")) ?? "see checks"}`,
    });
    publishFeed("autopilot_skip", `[risk] blocked ${proposal.marketTitle?.slice(0, 50)} — ${res.assessment.reasons[0]?.slice(0, 70)}`, { severity: "warn" });
    return { ok: false, filledNotionalUsd: 0 };
  }
  let order = res.order;
  if (order.filledSize < order.size && ["open", "partially_filled", "created"].includes(order.status)) {
    const canceled = await cancelOrder(order.id, "system");
    if (canceled) order = canceled;
  }
  if (order.filledSize <= 0) {
    record({
      kind: "skip",
      strategy,
      conditionId: proposal.conditionId,
      marketQuestion: proposal.marketTitle,
      reason: "no immediate fill at limit (IOC) — order canceled",
    });
    return { ok: false, filledNotionalUsd: 0 };
  }
  const managed = await getManaged();
  // carry the signal's mechanical exit plan (ECL: 50%/85% edge capture) —
  // the exit manager honors it ahead of the generic %-target
  const planMeta = signal.meta?.exitPlan as
    | { partialExitAt?: number; fullExitAt?: number }
    | undefined;
  const exitPlan =
    typeof planMeta?.partialExitAt === "number" && typeof planMeta?.fullExitAt === "number"
      ? { partialAt: planMeta.partialExitAt, fullAt: planMeta.fullExitAt }
      : undefined;
  managed.push({
    tokenId: proposal.tokenId,
    conditionId: proposal.conditionId,
    marketQuestion: proposal.marketTitle,
    outcome: proposal.outcome,
    strategy,
    mode: "paper",
    entryPrice: order.avgFillPrice ?? proposal.price,
    size: order.filledSize,
    openedAt: Date.now(),
    peakPrice: order.avgFillPrice ?? proposal.price,
    endDate,
    exitPlan,
  });
  await setManaged(managed);
  record({
    kind: "entry",
    strategy,
    conditionId: proposal.conditionId,
    marketQuestion: proposal.marketTitle,
    side: proposal.side,
    price: order.avgFillPrice ?? proposal.price,
    size: order.filledSize,
    orderId: order.id,
    approved: true,
    reason: `filled ${order.filledSize}/${proposal.size} @ ${(100 * (order.avgFillPrice ?? proposal.price)).toFixed(1)}c (${strategy}, score ${signal.score})`,
  });
  publishFeed("autopilot_entry", `[paper] BUY ${order.filledSize} ${proposal.outcome} @ ${(100 * (order.avgFillPrice ?? proposal.price)).toFixed(1)}c — ${proposal.marketTitle?.slice(0, 45)} (${strategy})`, {});
  return {
    ok: true,
    filledNotionalUsd: order.filledSize * (order.avgFillPrice ?? proposal.price),
  };
}

async function executeExit(
  pos: ManagedPosition,
  reason: string,
  detail: string,
  mode: "observe" | "paper" | "live" | "off",
  /** shares to sell; defaults to the whole lot */
  sellSize?: number,
): Promise<{ closedSize: number; remaining: number; pnlUsd: number }> {
  const toSell = Math.min(pos.size, Math.max(1, sellSize ?? pos.size));
  // a LIVE lot can only be exited under a live-armed session — never through
  // the paper book, never silently
  if (pos.mode === "live" && mode !== "live") {
    record({ kind: "skip", strategy: pos.strategy, conditionId: pos.conditionId, marketQuestion: pos.marketQuestion, reason: `exit signaled (${reason}) on a LIVE lot while autopilot mode is ${mode} — manual action required` });
    return { closedSize: 0, remaining: pos.size, pnlUsd: 0 };
  }
  if (mode === "live" && pos.mode === "live") {
    // live exits go through the intent pipeline under the armed session
    if (!isArmed()) {
      record({ kind: "skip", strategy: pos.strategy, conditionId: pos.conditionId, marketQuestion: pos.marketQuestion, reason: `exit signaled (${reason}) but live autopilot is disarmed — manual action required` });
      return { closedSize: 0, remaining: pos.size, pnlUsd: 0 };
    }
    const book = await getBook(pos.tokenId).catch(() => undefined);
    const price = Math.min(0.99, Math.max(0.01, book?.bestBid ?? pos.peakPrice));
    const { intent } = await createLiveIntent({
      mode: "live",
      conditionId: pos.conditionId,
      tokenId: pos.tokenId,
      outcome: pos.outcome,
      side: "SELL",
      orderType: "limit",
      price,
      size: toSell,
      origin: "autopilot",
      isExit: true,
    });
    let final = intent;
    if (intent.status !== "rejected") {
      final = await confirmLiveIntent(intent.id, undefined, { autopilotArmed: true }).catch(() => ({
        ...intent,
        status: "rejected" as const,
        error: "confirm threw",
      }));
    }
    const dispatched = final.status === "submitted";
    record({ kind: dispatched ? "exit" : "skip", strategy: pos.strategy, conditionId: pos.conditionId, marketQuestion: pos.marketQuestion, side: "SELL", price, size: toSell, orderId: intent.id, reason: `LIVE exit ${reason}: ${detail} (${final.status}${final.error ? ` — ${final.error}` : ""})${dispatched ? "" : " — lot stays managed, retrying next tick"}` });
    publishFeed("autopilot_exit", `[live] exit ${pos.marketQuestion?.slice(0, 45)} — ${reason} (${final.status})`, {
      severity: dispatched ? "info" : "warn",
    });
    // a rejected/failed live exit did NOT close anything: the lot must stay
    // managed so stops/trails/pre-close flattens keep retrying — silently
    // dropping a live position from exit management is the worst failure
    // mode this engine has
    return dispatched
      ? { closedSize: toSell, remaining: pos.size - toSell, pnlUsd: 0 }
      : { closedSize: 0, remaining: pos.size, pnlUsd: 0 };
  }

  // paper exit — market order into the book, exit-relaxed risk checks
  const book = await getBook(pos.tokenId).catch(() => undefined);
  const price = Math.min(0.99, Math.max(0.01, book?.bestBid ?? pos.entryPrice));
  const res = await placePaperOrder({
    mode: "paper",
    conditionId: pos.conditionId,
    tokenId: pos.tokenId,
    outcome: pos.outcome,
    side: "SELL",
    orderType: "market",
    price,
    size: toSell,
    origin: "autopilot",
    isExit: true,
  });
  if (res.rejected || !res.order) {
    record({ kind: "skip", strategy: pos.strategy, conditionId: pos.conditionId, marketQuestion: pos.marketQuestion, reason: `exit blocked (${reason}): ${res.assessment.reasons[0] ?? ""} — will retry next tick` });
    return { closedSize: 0, remaining: pos.size, pnlUsd: 0 };
  }
  const order = res.order;
  const closed = order.filledSize;
  const avgExit = order.avgFillPrice ?? price;
  const pnl = Number(((avgExit - pos.entryPrice) * closed).toFixed(2));
  record({
    kind: "exit",
    strategy: pos.strategy,
    conditionId: pos.conditionId,
    marketQuestion: pos.marketQuestion,
    side: "SELL",
    price: avgExit,
    size: closed,
    orderId: order.id,
    approved: true,
    reason: `exit ${reason}: ${detail} → ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
  });
  publishFeed("autopilot_exit", `[paper] exit ${closed} ${pos.outcome} @ ${(avgExit * 100).toFixed(1)}c — ${reason} (${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)})`, {
    severity: pnl < 0 ? "warn" : "info",
  });
  return { closedSize: closed, remaining: Math.max(0, pos.size - closed), pnlUsd: pnl };
}

/**
 * Register an externally-created lot (wallet-mimic paper tests) for exit
 * management. The exit sweep runs every scanner tick even with autopilot
 * OFF, so registered lots always have a way out: plan levels when provided,
 * plus the generic stop/trail/time/pre-close protections.
 */
export async function registerManagedLot(lot: ManagedPosition): Promise<void> {
  const managed = await getManaged();
  // one managed lot per token — a second mimic on the same token merges size
  const existing = managed.find((m) => m.tokenId === lot.tokenId && m.mode === lot.mode);
  if (existing) {
    const total = existing.size + lot.size;
    existing.entryPrice = Number(
      ((existing.entryPrice * existing.size + lot.entryPrice * lot.size) / total).toFixed(4),
    );
    existing.size = total;
    existing.peakPrice = Math.max(existing.peakPrice, lot.peakPrice);
    // the newest signal's exit plan reflects the freshest measured edge;
    // openedAt stays at the OLD entry (conservative: time-stop fires earlier)
    if (lot.exitPlan) {
      existing.exitPlan = lot.exitPlan;
      existing.partialDone = false;
    }
    existing.endDate = lot.endDate ?? existing.endDate;
  } else {
    managed.push(lot);
  }
  await setManaged(managed);
}

/** reset session counters + breaker (does not touch bandit memory) */
export async function resetAutopilotSession(): Promise<void> {
  const s = state();
  s.session = {
    startedAt: Date.now(),
    trades: 0,
    notionalUsd: 0,
    realizedPnlUsd: 0,
    tradesLastHour: 0,
    breakerTripped: false,
  };
  s.entryTs = [];
  record({ kind: "disarm", reason: "session counters reset by user" });
  await audit("user", "autopilot_session_reset", "Autopilot session counters reset", {
    feedType: "user_action",
  });
}
