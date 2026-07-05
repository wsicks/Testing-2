"use client";

import { useState } from "react";
import { useBacktest, useMarkets, type BacktestInput } from "@/hooks/api";
import { BACKTEST_STRATEGIES } from "@/lib/engine/backtest/backtester";
import { fmtDateTime, fmtSignedUsd, fmtUsd } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Num } from "@/components/ui/num";
import { EmptyNote, Spinner } from "@/components/ui/spinner";
import { DrawdownChart, EquityChart, Histogram } from "@/components/terminal/charts";

export default function BacktestingPage() {
  const { data: marketsData } = useMarkets({ sort: "volume24h", dir: "desc", limit: 40 });
  const backtest = useBacktest();
  const [selected, setSelected] = useState<string[]>([]);
  const [cfg, setCfg] = useState<Omit<BacktestInput, "conditionIds">>({
    strategyId: "momentum",
    days: 30,
    initialCapital: 10_000,
    positionPct: 2,
    holdBars: 24,
    targetPct: 15,
    stopPct: 10,
    feeRateBps: 0,
    slippageBps: 50,
    spreadAssumption: 0.02,
  });
  const set = (patch: Partial<typeof cfg>) => setCfg((c) => ({ ...c, ...patch }));
  const result = backtest.data?.result;

  const toggle = (cid: string) =>
    setSelected((s) =>
      s.includes(cid) ? s.filter((x) => x !== cid) : s.length < 8 ? [...s, cid] : s,
    );

  const returnsHist = result
    ? bucketize(result.trades.map((t) => t.returnPct))
    : [];

  return (
    <div className="space-y-2">
      <Panel
        title="backtest configuration"
        right={<Badge variant="warn">historical simulation — not predictive</Badge>}
      >
        <div className="grid grid-cols-2 gap-1.5 md:grid-cols-5">
          <Field label="strategy">
            <Select
              value={cfg.strategyId}
              onChange={(e) => set({ strategyId: e.target.value as BacktestInput["strategyId"] })}
            >
              {Object.entries(BACKTEST_STRATEGIES).map(([id, s]) => (
                <option key={id} value={id}>{s.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="date range (days back)">
            <Select value={cfg.days} onChange={(e) => set({ days: Number(e.target.value) })}>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </Select>
          </Field>
          <Field label="initial capital $">
            <Input type="number" value={cfg.initialCapital} onChange={(e) => set({ initialCapital: Number(e.target.value) })} />
          </Field>
          <Field label="position % of equity">
            <Input type="number" step="0.5" value={cfg.positionPct} onChange={(e) => set({ positionPct: Number(e.target.value) })} />
          </Field>
          <Field label="hold (bars)">
            <Input type="number" value={cfg.holdBars} onChange={(e) => set({ holdBars: Number(e.target.value) })} />
          </Field>
          <Field label="target %">
            <Input type="number" value={cfg.targetPct} onChange={(e) => set({ targetPct: Number(e.target.value) })} />
          </Field>
          <Field label="stop %">
            <Input type="number" value={cfg.stopPct} onChange={(e) => set({ stopPct: Number(e.target.value) })} />
          </Field>
          <Field label="fees (bps/side)">
            <Input type="number" value={cfg.feeRateBps} onChange={(e) => set({ feeRateBps: Number(e.target.value) })} />
          </Field>
          <Field label="slippage (bps/side)">
            <Input type="number" value={cfg.slippageBps} onChange={(e) => set({ slippageBps: Number(e.target.value) })} />
          </Field>
          <Field label="spread assumption">
            <Input type="number" step="0.005" value={cfg.spreadAssumption} onChange={(e) => set({ spreadAssumption: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="mt-2">
          <div className="label mb-1">
            market universe — pick up to 8 ({selected.length} selected)
          </div>
          <div className="grid max-h-40 grid-cols-1 gap-0.5 overflow-y-auto border border-line bg-paper p-1 md:grid-cols-2">
            {marketsData?.markets.map((m) => (
              <label key={m.conditionId} className="flex items-center gap-1.5 text-2xs">
                <input
                  type="checkbox"
                  checked={selected.includes(m.conditionId)}
                  onChange={() => toggle(m.conditionId)}
                />
                <span className="truncate">{m.question}</span>
                <span className="ml-auto shrink-0 text-ink-faint num">
                  {fmtUsd(m.volume24h, 0)}/24h
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="primary"
            size="md"
            disabled={selected.length === 0 || backtest.isPending}
            onClick={() => backtest.mutate({ ...cfg, conditionIds: selected })}
          >
            {backtest.isPending ? "running simulation…" : "run simulation"}
          </Button>
          {backtest.isPending ? <Spinner /> : null}
          {backtest.isError ? (
            <span className="text-2xs text-neg">{(backtest.error as Error).message}</span>
          ) : null}
        </div>
      </Panel>

      {result ? (
        <>
          <Panel
            title={result.label.toLowerCase()}
            right={<Badge variant="warn">historical simulation</Badge>}
          >
            <div className="grid grid-cols-2 gap-1 text-2xs md:grid-cols-8">
              <Stat label="total return" v={`${result.stats.totalReturnPct}%`} tone={result.stats.totalReturnPct} />
              <Stat label="max drawdown" v={`-${result.stats.maxDrawdownPct}%`} tone={-1} />
              <Stat label="trades" v={String(result.stats.trades)} />
              <Stat label="win rate" v={`${result.stats.winRate}%`} />
              <Stat label="avg win" v={fmtUsd(result.stats.avgWin)} tone={1} />
              <Stat label="avg loss" v={fmtUsd(result.stats.avgLoss)} tone={-1} />
              {/* Infinity (no losing trades) JSON-serializes to null — render ∞ */}
              <Stat label="profit factor" v={Number.isFinite(result.stats.profitFactor) ? String(result.stats.profitFactor) : "∞ (no losses)"} />
              <Stat label="fees paid" v={fmtUsd(result.stats.feesPaid)} />
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <div className="label mb-0.5">equity curve (simulated)</div>
                <EquityChart series={result.equityCurve} refValue={result.config.initialCapital} />
                <div className="label mb-0.5 mt-2">drawdown</div>
                <DrawdownChart series={result.drawdownCurve} />
              </div>
              <div>
                <div className="label mb-0.5">win/loss return distribution</div>
                <Histogram data={returnsHist} />
                <div className="label mb-0.5 mt-2">assumptions</div>
                <ul className="space-y-0.5 border border-line bg-paper p-1.5 text-3xs text-ink-soft">
                  {result.assumptions.map((a, i) => (
                    <li key={i}>• {a}</li>
                  ))}
                </ul>
              </div>
            </div>
          </Panel>
          <Panel title={`trade log (${result.trades.length})`} bodyClassName="max-h-72 overflow-y-auto p-0">
            {result.trades.length === 0 ? (
              <EmptyNote>strategy produced no trades on this universe/range</EmptyNote>
            ) : (
              <table className="w-full text-2xs">
                <thead className="sticky top-0 bg-paper">
                  <tr className="border-b border-line-strong text-left">
                    {["entry", "exit", "market", "dir", "entry px", "exit px", "size", "pnl", "return", "exit reason"].map((h) => (
                      <th key={h} className="cell label">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.trades.map((t, i) => (
                    <tr key={i} className="border-b border-line/60">
                      <td className="cell"><Num className="text-ink-faint">{fmtDateTime(t.entryTs * 1000)}</Num></td>
                      <td className="cell"><Num className="text-ink-faint">{fmtDateTime(t.exitTs * 1000)}</Num></td>
                      <td className="max-w-56 truncate px-2 py-1">{t.marketTitle}</td>
                      <td className="cell"><Num tone={t.side === "BUY" ? "pos" : "neg"}>{t.side === "BUY" ? "LONG" : "SHORT"}</Num></td>
                      <td className="cell"><Num>{(t.entryPrice * 100).toFixed(1)}c</Num></td>
                      <td className="cell"><Num>{(t.exitPrice * 100).toFixed(1)}c</Num></td>
                      <td className="cell"><Num>{t.size}</Num></td>
                      <td className="cell"><Num tone={t.pnl}>{fmtSignedUsd(t.pnl)}</Num></td>
                      <td className="cell"><Num tone={t.returnPct}>{(t.returnPct * 100).toFixed(1)}%</Num></td>
                      <td className="cell text-ink-faint">{t.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      ) : (
        <Panel title="results">
          <EmptyNote>
            configure a universe and run the simulation — results include the
            full cost model and are labeled as historical simulation
          </EmptyNote>
        </Panel>
      )}
    </div>
  );
}

function Stat({ label, v, tone }: { label: string; v: string; tone?: number }) {
  return (
    <div className="border border-line bg-paper px-1.5 py-1">
      <div className="label">{label}</div>
      <Num tone={tone}>{v}</Num>
    </div>
  );
}

function bucketize(returns: number[]): { bucket: number; count: number }[] {
  if (!returns.length) return [];
  const lo = Math.min(...returns);
  const hi = Math.max(...returns);
  const n = 15;
  const w = (hi - lo) / n || 1;
  const out = Array.from({ length: n }, (_, i) => ({ bucket: lo + (i + 0.5) * w, count: 0 }));
  for (const r of returns) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((r - lo) / w)));
    out[i].count += 1;
  }
  return out;
}
