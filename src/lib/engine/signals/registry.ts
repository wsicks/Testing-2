// Plug-in registry for signal strategies. Add a strategy by importing its
// module and appending it here — everything else (scanner, UI, persistence,
// audit) picks it up automatically.

import type { SignalStrategy, SignalContext, SignalResult } from "@/lib/types";
import { liquiditySpreadSignal } from "./liquiditySpread";
import { priceMovementSignal } from "./priceMovement";
import { complementSignal } from "./complement";
import { crossMarketSignal } from "./crossMarket";
import { closingSoonSignal } from "./closingSoon";
import { dislocationSignal } from "./dislocation";
import { microstructureSignal } from "./microstructure";
import { referencePriceSignal } from "./referencePrice";
import { venueDivergenceSignal } from "./venueDivergence";
import { eclSignal } from "./ecl";
import { walletShadowSignal } from "./walletShadow";
import { walletFadeSignal } from "./walletFade";
import { deadlineCurvatureSignal } from "./deadlineCurvature";
import { mmAbsenceSignal } from "./mmAbsence";
import { liquidityVacuumSignal } from "./liquidityVacuum";
import { flowToxicitySignal } from "./flowToxicity";
import { phantomDepthSignal } from "./phantomDepth";
import { favoriteConvergenceSignal } from "./favoriteConvergence";

export const STRATEGIES: SignalStrategy[] = [
  liquiditySpreadSignal,
  priceMovementSignal,
  complementSignal,
  crossMarketSignal,
  closingSoonSignal,
  dislocationSignal,
  microstructureSignal,
  referencePriceSignal,
  venueDivergenceSignal,
  eclSignal,
  walletShadowSignal,
  walletFadeSignal,
  deadlineCurvatureSignal,
  mmAbsenceSignal,
  liquidityVacuumSignal,
  flowToxicitySignal,
  phantomDepthSignal,
  favoriteConvergenceSignal,
];

export function getStrategy(id: string): SignalStrategy | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

/** Run every registered strategy against one market context. */
export function runAllStrategies(
  ctx: SignalContext,
  onError?: (strategyId: string, err: unknown) => void,
): SignalResult[] {
  const out: SignalResult[] = [];
  for (const s of STRATEGIES) {
    try {
      const r = s.run(ctx);
      if (r) out.push(r);
    } catch (err) {
      // a strategy crash must never take down the scan loop — but it must
      // never vanish silently either; the caller decides where it's logged
      onError?.(s.id, err);
    }
  }
  return out;
}
