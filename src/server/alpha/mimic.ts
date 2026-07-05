// Wallet follow execution — copy/fade modes.
//
//   watch_only    → nothing executes (default)
//   confirm_only  → wallet signals surface as confirmation for OTHER signals
//   paper_mimic   → proposed wallet_shadow signals place PAPER test orders
//   paper_fade    → proposed wallet_fade signals place PAPER test orders
//
// Live wallet-copying does not exist as an automatic path AT ALL. A human
// can open a manual live preview from a wallet signal, which routes through
// the standard intent flow (risk engine, per-venue live gate, typed
// confirmation). This module only ever touches the paper book, and every
// order still passes the independent risk engine.

import type { NormalizedMarket, SignalResult } from "@/lib/types";
import { audit } from "../audit";
import { registerManagedLot } from "../autopilot";
import { cancelOrder, placePaperOrder } from "../execution";
import { getStore } from "../store";

const MAX_MIMICS_PER_TICK = 2;

export interface MimicRunResult {
  placed: number;
  skipped: number;
}

export async function runMimicExecutor(
  signals: SignalResult[],
  markets: NormalizedMarket[],
): Promise<MimicRunResult> {
  const store = await getStore();
  const settings = await store.getSettings();
  const mode = settings.alpha.walletFollowMode;
  if (mode !== "paper_mimic" && mode !== "paper_fade") return { placed: 0, skipped: 0 };
  if (settings.killSwitch) return { placed: 0, skipped: 0 };

  const strategy = mode === "paper_mimic" ? "wallet_shadow" : "wallet_fade";
  const marketById = new Map(markets.map((m) => [m.conditionId, m]));
  let placed = 0, skipped = 0;

  for (const sig of signals) {
    if (placed >= MAX_MIMICS_PER_TICK) break;
    if (sig.strategy !== strategy || sig.status !== "proposed") continue;
    if (sig.direction === "NEUTRAL" || !sig.conditionId) continue;
    const market = marketById.get(sig.conditionId);
    if (!market || market.venueId !== "polymarket") continue;

    const buyYes = sig.direction === "BUY_YES";
    const tokenId = buyYes ? market.yesTokenId : market.noTokenId;
    const yesAsk = market.bestAsk ?? market.yesPrice;
    const price = buyYes
      ? yesAsk
      : market.bestBid !== undefined
        ? 1 - market.bestBid
        : market.noPrice;
    if (!tokenId || price === undefined || price <= 0.02 || price >= 0.98) {
      skipped += 1;
      continue;
    }
    const testUsd = Math.min(
      typeof sig.meta?.suggestedTestUsd === "number" ? (sig.meta.suggestedTestUsd as number) : 10,
      settings.alpha.testOrderUsd,
      25,
    );
    if (testUsd < 1) {
      skipped += 1;
      continue;
    }
    const size = Math.max(1, Math.floor(testUsd / price));
    try {
      // placePaperOrder runs the full risk engine — a mimic is never exempt
      const res = await placePaperOrder({
        mode: "paper",
        conditionId: sig.conditionId,
        tokenId,
        outcome: buyYes ? "Yes" : "No",
        side: "BUY",
        orderType: "limit",
        price: Number(price.toFixed(3)),
        size,
        signalScore: sig.score,
        signalId: sig.id,
        origin: "wallet_mimic",
      });
      if (!res.rejected) {
        placed += 1;
        // IOC semantics: cancel any unfilled remainder NOW. A resting mimic
        // order that settlement fills minutes later would create shares no
        // ManagedPosition covers — an orphaned lot the exit sweep never sells.
        if (
          res.order &&
          res.order.filledSize < res.order.size &&
          ["open", "partially_filled", "created"].includes(res.order.status)
        ) {
          await cancelOrder(res.order.id, "system");
        }
        // register the filled lot for exit management — the exit sweep runs
        // every scanner tick even with autopilot OFF, so a mimic test is
        // never an orphaned position. Exit plan mirrors the ECL convention
        // over the wallet strategy's MEASURED expected edge.
        const filled = res.order?.filledSize ?? 0;
        if (filled > 0) {
          const entry = res.order?.avgFillPrice ?? price;
          const edge =
            typeof sig.meta?.remainingEdge === "number"
              ? (sig.meta.remainingEdge as number)
              : typeof sig.meta?.netEdge === "number"
                ? (sig.meta.netEdge as number)
                : 0;
          await registerManagedLot({
            tokenId,
            conditionId: sig.conditionId,
            marketQuestion: market.question,
            outcome: buyYes ? "Yes" : "No",
            strategy: sig.strategy,
            mode: "paper",
            entryPrice: entry,
            size: filled,
            openedAt: Date.now(),
            peakPrice: entry,
            endDate: market.endDate,
            exitPlan:
              edge > 0.01
                ? {
                    partialAt: Number((entry + 0.6 * edge).toFixed(3)),
                    fullAt: Number((entry + 0.85 * edge).toFixed(3)),
                  }
                : undefined,
          });
        }
        await audit(
          "execution",
          "wallet_mimic_paper",
          `Paper ${mode === "paper_mimic" ? "MIMIC" : "FADE"} $${testUsd.toFixed(0)} on ${market.question.slice(0, 60)} (wallet ${String(sig.meta?.walletName ?? sig.meta?.walletId ?? "?")}) — lot registered for exit management`,
          { data: { signalId: sig.id, orderId: res.order?.id } },
        );
      } else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { placed, skipped };
}
