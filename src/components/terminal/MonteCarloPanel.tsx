"use client";

// Monte Carlo position-sizing simulator. Pure client-side computation with a
// fixed seed; outputs are risk distributions, explicitly not profit claims.

import { useMemo, useState } from "react";
import { runMonteCarlo } from "@/lib/engine/montecarlo/monteCarlo";
import { fmtPct } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Num } from "@/components/ui/num";
import { Field, Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { BandChart, Histogram } from "./charts";

export function MonteCarloPanel({ className }: { className?: string }) {
  const [winRate, setWinRate] = useState("52");
  const [avgWin, setAvgWin] = useState("40");
  const [avgLoss, setAvgLoss] = useState("45");
  const [posPct, setPosPct] = useState("1");
  const [nTrades, setNTrades] = useState("200");
  const [seedRun, setSeedRun] = useState(0);

  const result = useMemo(() => {
    if (seedRun === 0) return undefined;
    return runMonteCarlo({
      winRate: Math.min(0.99, Math.max(0.01, Number(winRate) / 100)),
      avgWinPct: Math.max(0.1, Number(avgWin)),
      avgLossPct: Math.max(0.1, Number(avgLoss)),
      positionPct: Math.max(0.05, Number(posPct)),
      numTrades: Math.min(2000, Math.max(10, Number(nTrades))),
      numPaths: 1000,
      initialCapital: 10_000,
      seed: 1337 + seedRun,
    });
  }, [seedRun, winRate, avgWin, avgLoss, posPct, nTrades]);

  return (
    <Panel
      title="monte carlo — position sizing"
      className={className}
      right={<Badge variant="warn">risk display — not a profit claim</Badge>}
    >
      <div className="grid grid-cols-2 gap-1 md:grid-cols-6">
        <Field label="win rate %">
          <Input type="number" value={winRate} onChange={(e) => setWinRate(e.target.value)} />
        </Field>
        <Field label="avg win % of stake">
          <Input type="number" value={avgWin} onChange={(e) => setAvgWin(e.target.value)} />
        </Field>
        <Field label="avg loss % of stake">
          <Input type="number" value={avgLoss} onChange={(e) => setAvgLoss(e.target.value)} />
        </Field>
        <Field label="position % of equity">
          <Input type="number" step="0.25" value={posPct} onChange={(e) => setPosPct(e.target.value)} />
        </Field>
        <Field label="# trades">
          <Input type="number" value={nTrades} onChange={(e) => setNTrades(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <Button
            variant="primary"
            className="w-full"
            onClick={() => setSeedRun((x) => x + 1)}
          >
            simulate 1,000 paths
          </Button>
        </div>
      </div>

      {result ? (
        <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className="label mb-0.5">equity multiple percentile bands (p5–p95)</div>
            <BandChart paths={result.paths} />
          </div>
          <div>
            <div className="label mb-0.5">final return distribution</div>
            <Histogram data={result.histogram} />
          </div>
          <div className="grid grid-cols-2 gap-1 text-2xs lg:col-span-3 lg:grid-cols-6">
            <MetricBox label="median outcome" v={fmtPct(result.finalEquityPercentiles.p50)} tone={result.finalEquityPercentiles.p50} />
            <MetricBox label="p5 (bad) outcome" v={fmtPct(result.finalEquityPercentiles.p5)} tone={result.finalEquityPercentiles.p5} />
            <MetricBox label="p95 outcome" v={fmtPct(result.finalEquityPercentiles.p95)} tone={result.finalEquityPercentiles.p95} />
            <MetricBox label="worst 5% avg" v={fmtPct(result.worst5PctOutcome)} tone={result.worst5PctOutcome} />
            <MetricBox
              label="median max drawdown"
              v={fmtPct(result.maxDrawdownPercentiles.p50)}
              tone={-result.maxDrawdownPercentiles.p50}
            />
            <MetricBox
              label="risk of ruin (−90%)"
              v={fmtPct(result.riskOfRuin, 2)}
              tone={result.riskOfRuin > 0.01 ? -1 : 0}
            />
          </div>
          <p className="text-3xs text-ink-faint lg:col-span-3">
            Simulation of user-supplied assumptions with a fixed random seed.
            Distributions describe what those assumptions imply — they say
            nothing about whether the assumptions are achievable.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-2xs text-ink-faint">
          Set assumptions and run the simulation to see PnL distribution,
          drawdown distribution, risk of ruin and the worst-5% scenario.
        </p>
      )}
    </Panel>
  );
}

function MetricBox({
  label,
  v,
  tone,
}: {
  label: string;
  v: string;
  tone?: number;
}) {
  return (
    <div className="border border-line bg-paper px-1.5 py-1">
      <div className="label">{label}</div>
      <Num tone={tone}>{v}</Num>
    </div>
  );
}
