// Strategy 16 — Flow Toxicity (Feature Forge #14).
//
// Informational read of the public tape: informed / market-making / noise /
// mixed, from measurable structure (imbalance, size concentration, arrival
// burstiness, side alternation). NEUTRAL always — the classification is
// context for other strategies and for humans, never a trade by itself:
// "informed" says someone is paying to act, not that they are right.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { classifyFlow } from "../micro/toxicity";
import { buildSignal, check } from "./helpers";

export const flowToxicitySignal: SignalStrategy = {
  id: "flow_toxicity",
  label: "Flow Toxicity",
  description:
    "Classifies recent tape flow (informed / market-making / noise) from measurable structure. Informational context — never a trade.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, trades, now } = ctx;
    if (market.outcomeType !== "binary" || !trades || trades.length < 12) return null;
    const flow = classifyFlow(trades);
    if (!flow) return null;
    // only surface decisive reads — "mixed" is most tapes and not news
    if (flow.classification === "mixed" || flow.confidence < 0.4) return null;

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction: "NEUTRAL",
      score: 20 + 60 * flow.confidence,
      summary: `FLOW: ${flow.classification.toUpperCase().replace("_", " ")} (${(flow.confidence * 100).toFixed(0)}% confidence) — ${flow.trades} prints, imbalance ${(flow.imbalance * 100).toFixed(0)}%, top-3 share ${(flow.sizeConcentration * 100).toFixed(0)}%${flow.classification === "informed" ? " — someone is paying to act; NOT evidence they are right" : ""}`,
      checks: [
        check("flow_classified", true,
          `imbalance ${(flow.imbalance * 100).toFixed(0)}% · size concentration ${(flow.sizeConcentration * 100).toFixed(0)}% · burstiness ${flow.burstiness.toFixed(1)} · alternation ${(flow.alternation * 100).toFixed(0)}% over ${flow.spanMinutes}min`,
          flow.confidence),
        check("informational_only", false,
          "flow classification is context for other strategies and humans — a structural read of the tape, never a trade trigger"),
      ],
      now,
      ttlMs: 10 * 60_000,
      meta: {
        signalType: "flow_toxicity",
        ...flow,
      },
    });
  },
};
