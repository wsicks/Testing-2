import type { AutopilotDecision, NormalizedMarket, SignalResult } from "@/lib/types";
import type { PrivateEdgeProfile } from "@/lib/alpha/privateEdge";
import type { SignalExecutionQuality } from "../marketIntelligence";

export interface AutopilotReplayFrame {
  id: string;
  ts: number;
  strategy?: string;
  conditionId?: string;
  marketQuestion?: string;
  decisionKind: AutopilotDecision["kind"];
  reason: string;
  signalScore?: number;
  marketSpread?: number;
  marketLiquidity?: number;
  privateEdgeCents?: number;
  privateEdgeSamples?: number;
  fillProbability?: number;
  adverseSelectionRisk?: number;
  gates: { name: string; passed: boolean; detail: string }[];
}

export interface ReplayFrameInput {
  decision: AutopilotDecision;
  signal?: SignalResult;
  market?: NormalizedMarket;
  privateEdge?: PrivateEdgeProfile;
  execution?: SignalExecutionQuality;
}

export function buildReplayFrame(input: ReplayFrameInput): AutopilotReplayFrame {
  const { decision, signal, market, privateEdge, execution } = input;
  const gates = [
    {
      name: "signal",
      passed: signal ? signal.status === "proposed" : decision.kind !== "entry",
      detail: signal ? `${signal.status} score ${signal.score}` : "no signal attached",
    },
    {
      name: "market",
      passed: market ? market.tradable && !market.referenceOnly : decision.kind !== "entry",
      detail: market ? `${market.venueId} spread ${((market.spread ?? 0) * 100).toFixed(2)}c` : "no market attached",
    },
    {
      name: "private_edge",
      passed: privateEdge ? privateEdge.sampleReady ? privateEdge.avgNetDrift1h > 0 : true : true,
      detail: privateEdge
        ? `${privateEdge.n} samples, ${privateEdge.edgeCents.toFixed(2)}c net edge`
        : "no private edge profile",
    },
    {
      name: "execution",
      passed: execution ? execution.fillProbability >= 0.18 && execution.adverseSelectionRisk <= 0.75 : true,
      detail: execution
        ? `${(execution.fillProbability * 100).toFixed(0)}% fill, ${(execution.adverseSelectionRisk * 100).toFixed(0)}% adverse risk`
        : "no execution snapshot",
    },
  ];

  return {
    id: decision.id,
    ts: decision.ts,
    strategy: decision.strategy ?? signal?.strategy,
    conditionId: decision.conditionId ?? signal?.conditionId,
    marketQuestion: decision.marketQuestion ?? signal?.marketQuestion ?? market?.question,
    decisionKind: decision.kind,
    reason: decision.reason,
    signalScore: signal?.score,
    marketSpread: market?.spread,
    marketLiquidity: market?.liquidity,
    privateEdgeCents: privateEdge?.edgeCents,
    privateEdgeSamples: privateEdge?.n,
    fillProbability: execution?.fillProbability,
    adverseSelectionRisk: execution?.adverseSelectionRisk,
    gates,
  };
}
