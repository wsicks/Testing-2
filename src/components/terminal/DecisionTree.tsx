"use client";

// Explainable trading-logic tree (React Flow). Every node reflects a real
// check from the risk assessment / signal for the selected market — no opaque
// recommendations.

import { useMemo } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { RiskAssessment, SignalResult } from "@/lib/types";
import { Panel } from "@/components/ui/panel";
import { EmptyNote } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type CheckNodeData = {
  label: string;
  detail: string;
  state: "pass" | "fail" | "warn" | "info";
};

function CheckNode({ data }: NodeProps) {
  const d = data as CheckNodeData;
  return (
    <div
      className={cn(
        "w-44 border px-2 py-1 text-left",
        d.state === "pass" && "border-pos/50 bg-pos-soft",
        d.state === "fail" && "border-neg/50 bg-neg-soft",
        d.state === "warn" && "border-warn/50 bg-warn-soft",
        d.state === "info" && "border-line-strong bg-panel",
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-line-strong" />
      <div className="flex items-center justify-between gap-1">
        <span className="text-3xs font-bold uppercase tracking-wide text-ink">
          {d.label}
        </span>
        <span
          className={cn(
            "num text-3xs font-bold",
            d.state === "pass" && "text-pos",
            d.state === "fail" && "text-neg",
            d.state === "warn" && "text-warn",
            d.state === "info" && "text-ink-faint",
          )}
        >
          {d.state === "info" ? "•" : d.state}
        </span>
      </div>
      <div className="mt-0.5 line-clamp-3 text-3xs leading-tight text-ink-soft">
        {d.detail}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-line-strong" />
    </div>
  );
}

const nodeTypes = { check: CheckNode };

function findCheck(assessment: RiskAssessment | undefined, name: string) {
  return assessment?.checks.find((c) => c.name === name);
}

export function DecisionTree({
  marketTitle,
  assessment,
  signal,
  className,
}: {
  marketTitle?: string;
  assessment?: RiskAssessment;
  signal?: SignalResult;
  className?: string;
}) {
  const { nodes, edges } = useMemo(() => {
    if (!marketTitle) return { nodes: [] as Node[], edges: [] as Edge[] };

    const st = (c?: { passed: boolean; severity?: string }): CheckNodeData["state"] =>
      !c ? "info" : c.passed ? "pass" : c.severity === "warn" ? "warn" : "fail";

    const freshness = findCheck(assessment, "data_freshness");
    const liquidity = findCheck(assessment, "liquidity_floor");
    const spread = findCheck(assessment, "spread_limit");
    const slippage = findCheck(assessment, "slippage");
    const size = findCheck(assessment, "trade_size_limit");
    const exposure =
      findCheck(assessment, "market_exposure") ??
      findCheck(assessment, "category_exposure");

    const defs: { id: string; data: CheckNodeData }[] = [
      {
        id: "market",
        data: {
          label: "market selected",
          detail: marketTitle.slice(0, 90),
          state: "info",
        },
      },
      {
        id: "quality",
        data: {
          label: "data quality",
          detail: freshness?.detail ?? "run a preview to evaluate freshness",
          state: st(freshness),
        },
      },
      {
        id: "liquidity",
        data: {
          label: "liquidity check",
          detail: liquidity?.detail ?? "awaiting risk evaluation",
          state: st(liquidity),
        },
      },
      {
        id: "spread",
        data: {
          label: "spread check",
          detail: spread?.detail ?? "awaiting risk evaluation",
          state: st(spread),
        },
      },
      {
        id: "ev",
        data: {
          label: "ev estimate",
          detail: assessment
            ? `EV ${assessment.expectedValueUsd >= 0 ? "+" : ""}$${assessment.expectedValueUsd.toFixed(2)} | gross edge ${(assessment.grossEdge * 100).toFixed(1)}c`
            : "awaiting risk evaluation",
          state: assessment
            ? assessment.expectedValueUsd > 0
              ? "pass"
              : "warn"
            : "info",
        },
      },
      {
        id: "slippage",
        data: {
          label: "slippage estimate",
          detail: slippage?.detail ?? "awaiting book data",
          state: st(slippage ? { ...slippage, severity: "warn" } : undefined),
        },
      },
      {
        id: "fees",
        data: {
          label: "fee estimate",
          detail: assessment
            ? `required edge ${(assessment.requiredEdge * 100).toFixed(2)}c (spread/2 + fees + slippage)`
            : "awaiting risk evaluation",
          state: "info",
        },
      },
      {
        id: "sizing",
        data: {
          label: "risk sizing",
          detail: assessment
            ? `kelly ${(assessment.kellyFraction * 100).toFixed(1)}% → capped ${(assessment.cappedKellyFraction * 100).toFixed(2)}% ($${assessment.suggestedSizeUsd.toFixed(0)})`
            : "awaiting risk evaluation",
          state: st(size),
        },
      },
      {
        id: "exposure",
        data: {
          label: "portfolio exposure",
          detail:
            exposure?.detail ??
            (assessment
              ? `after-trade ${assessment.exposureAfterPct.toFixed(1)}% total`
              : "awaiting risk evaluation"),
          state: st(exposure),
        },
      },
      {
        id: "final",
        data: {
          label: "final recommendation",
          detail: assessment
            ? assessment.reasons[0] ?? ""
            : signal
              ? `${signal.strategyLabel}: ${signal.summary.slice(0, 80)}`
              : "no evaluation yet — open the order ticket and preview",
          state: assessment ? (assessment.approved ? "pass" : "fail") : "info",
        },
      },
    ];

    const nodes: Node[] = defs.map((d, i) => ({
      id: d.id,
      type: "check",
      position: { x: (i % 2) * 200, y: Math.floor(i / 2) * 92 },
      data: d.data,
      draggable: false,
      selectable: false,
    }));
    const edges: Edge[] = defs.slice(1).map((d, i) => ({
      id: `e${i}`,
      source: defs[i].id,
      target: d.id,
      animated: d.data.state === "fail",
      style: { stroke: "#cfc7b5" },
    }));
    return { nodes, edges };
  }, [marketTitle, assessment, signal]);

  return (
    <Panel title="strategy decision tree" className={className} bodyClassName="p-0">
      {nodes.length === 0 ? (
        <EmptyNote>select a market to trace the decision logic</EmptyNote>
      ) : (
        <div className="h-[480px]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.08 }}
            proOptions={{ hideAttribution: true }}
            zoomOnScroll={false}
            panOnDrag
            nodesConnectable={false}
            elementsSelectable={false}
          >
            <Background color="#e4ded1" gap={14} />
          </ReactFlow>
        </div>
      )}
    </Panel>
  );
}
