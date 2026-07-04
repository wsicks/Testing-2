// Autopilot exit manager — pure rule evaluation over managed positions.
// Exit reasons, in priority order: pre-close flatten, stop, trailing stop,
// target, time stop. Exits are risk-reducing and always allowed to fire even
// when entry conditions have deteriorated.

import type { AutopilotConfig, ManagedPosition } from "@/lib/types";

export interface ExitDecision {
  position: ManagedPosition;
  action: "hold" | "exit";
  reason?: "pre_close" | "stop" | "trail" | "target" | "time";
  detail: string;
  /** updated peak for trailing logic */
  peakPrice: number;
}

export function evaluateExit(
  pos: ManagedPosition,
  markPrice: number | undefined,
  config: AutopilotConfig,
  now = Date.now(),
): ExitDecision {
  const peak = Math.max(pos.peakPrice, markPrice ?? pos.peakPrice);
  if (markPrice === undefined) {
    return { position: pos, action: "hold", detail: "no mark price this tick", peakPrice: peak };
  }
  const pnlPct = ((markPrice - pos.entryPrice) / pos.entryPrice) * 100;

  // 1) flatten ahead of resolution
  if (pos.endDate) {
    const minsLeft = (new Date(pos.endDate).getTime() - now) / 60_000;
    if (minsLeft <= config.flattenBeforeCloseMin) {
      return {
        position: pos,
        action: "exit",
        reason: "pre_close",
        detail: `market closes in ${Math.max(0, minsLeft).toFixed(0)}m (flatten window ${config.flattenBeforeCloseMin}m)`,
        peakPrice: peak,
      };
    }
  }
  // 2) hard stop
  if (pnlPct <= -config.stopPct) {
    return {
      position: pos,
      action: "exit",
      reason: "stop",
      detail: `pnl ${pnlPct.toFixed(1)}% breached stop -${config.stopPct}%`,
      peakPrice: peak,
    };
  }
  // 3) trailing stop — active once the position has been in profit
  const trailFloor = peak * (1 - config.trailPct / 100);
  if (peak > pos.entryPrice * 1.01 && markPrice <= trailFloor) {
    return {
      position: pos,
      action: "exit",
      reason: "trail",
      detail: `price ${(markPrice * 100).toFixed(1)}c fell ${config.trailPct}% from peak ${(peak * 100).toFixed(1)}c`,
      peakPrice: peak,
    };
  }
  // 4) target
  if (pnlPct >= config.targetPct) {
    return {
      position: pos,
      action: "exit",
      reason: "target",
      detail: `pnl +${pnlPct.toFixed(1)}% reached target +${config.targetPct}%`,
      peakPrice: peak,
    };
  }
  // 5) time stop
  const heldMin = (now - pos.openedAt) / 60_000;
  if (heldMin >= config.maxHoldMin) {
    return {
      position: pos,
      action: "exit",
      reason: "time",
      detail: `held ${heldMin.toFixed(0)}m ≥ max ${config.maxHoldMin}m`,
      peakPrice: peak,
    };
  }
  return {
    position: pos,
    action: "hold",
    detail: `pnl ${pnlPct.toFixed(1)}%, held ${heldMin.toFixed(0)}m, peak ${(peak * 100).toFixed(1)}c`,
    peakPrice: peak,
  };
}
