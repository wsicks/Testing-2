"use client";

// Recharts-based terminal charts: probability price line, book depth,
// equity/drawdown curves, histograms, Monte Carlo bands.

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BookLevel, PricePoint } from "@/lib/types";

const INK = "#26231d";
const FAINT = "#8a8272";
const LINE = "#e4ded1";
const POS = "#15803d";
const NEG = "#b91c1c";
const ACCENT = "#1d4ed8";

const axisProps = {
  stroke: FAINT,
  fontSize: 9,
  tickLine: false,
  axisLine: { stroke: LINE },
} as const;

const tooltipStyle = {
  contentStyle: {
    background: "#fffdf9",
    border: `1px solid ${LINE}`,
    fontSize: 10,
    fontFamily: "ui-monospace, monospace",
    padding: "2px 6px",
  },
  labelStyle: { color: FAINT },
} as const;

function tsFmt(t: number): string {
  const d = new Date(t * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:00`;
}

export function PriceChart({
  history,
  height = 220,
}: {
  history: PricePoint[];
  height?: number;
}) {
  const data = history.map((p) => ({ t: p.t, price: p.p * 100 }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: -18 }}>
        <defs>
          <linearGradient id="pq-price" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity={0.18} />
            <stop offset="100%" stopColor={ACCENT} stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={LINE} strokeDasharray="2 3" vertical={false} />
        <XAxis dataKey="t" tickFormatter={tsFmt} {...axisProps} minTickGap={48} />
        <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}c`} {...axisProps} width={44} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(t) => tsFmt(Number(t))}
          formatter={(v) => [`${Number(v).toFixed(1)}c`, "price"]}
        />
        <Area
          type="stepAfter"
          dataKey="price"
          stroke={ACCENT}
          strokeWidth={1.2}
          fill="url(#pq-price)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function DepthChart({
  bids,
  asks,
  height = 160,
}: {
  bids: BookLevel[];
  asks: BookLevel[];
  height?: number;
}) {
  // cumulative depth from best price outward
  let acc = 0;
  const bidPts = bids.map((l) => ({ price: l.price * 100, bid: (acc += l.price * l.size) }));
  acc = 0;
  const askPts = asks.map((l) => ({ price: l.price * 100, ask: (acc += l.price * l.size) }));
  const data = [...bidPts.reverse(), ...askPts];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: -14 }}>
        <CartesianGrid stroke={LINE} strokeDasharray="2 3" vertical={false} />
        <XAxis
          dataKey="price"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(v) => `${Number(v).toFixed(0)}c`}
          {...axisProps}
        />
        <YAxis tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} {...axisProps} width={40} />
        <Tooltip
          {...tooltipStyle}
          formatter={(v, name) => [`$${Math.round(Number(v)).toLocaleString()}`, String(name)]}
          labelFormatter={(v) => `${Number(v).toFixed(1)}c`}
        />
        <Area type="stepAfter" dataKey="bid" stroke={POS} fill={POS} fillOpacity={0.12} strokeWidth={1.2} isAnimationActive={false} />
        <Area type="stepBefore" dataKey="ask" stroke={NEG} fill={NEG} fillOpacity={0.12} strokeWidth={1.2} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function EquityChart({
  series,
  height = 180,
  msTimestamps = false,
  refValue,
}: {
  series: { t: number; equity: number }[];
  height?: number;
  msTimestamps?: boolean;
  refValue?: number;
}) {
  const fmt = (t: number) => tsFmt(msTimestamps ? t / 1000 : t);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={series} margin={{ top: 4, right: 6, bottom: 0, left: -8 }}>
        <CartesianGrid stroke={LINE} strokeDasharray="2 3" vertical={false} />
        <XAxis dataKey="t" tickFormatter={fmt} {...axisProps} minTickGap={60} />
        <YAxis
          domain={["auto", "auto"]}
          tickFormatter={(v) => `$${Math.round(Number(v)).toLocaleString()}`}
          {...axisProps}
          width={56}
        />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(t) => fmt(Number(t))}
          formatter={(v) => [`$${Number(v).toFixed(2)}`, "equity"]}
        />
        {refValue !== undefined ? (
          <ReferenceLine y={refValue} stroke={FAINT} strokeDasharray="3 3" />
        ) : null}
        <Line
          type="monotone"
          dataKey="equity"
          stroke={INK}
          strokeWidth={1.2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function DrawdownChart({
  series,
  height = 120,
  msTimestamps = false,
}: {
  series: { t: number; dd: number }[];
  height?: number;
  msTimestamps?: boolean;
}) {
  const fmt = (t: number) => tsFmt(msTimestamps ? t / 1000 : t);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={series} margin={{ top: 4, right: 6, bottom: 0, left: -14 }}>
        <CartesianGrid stroke={LINE} strokeDasharray="2 3" vertical={false} />
        <XAxis dataKey="t" tickFormatter={fmt} {...axisProps} minTickGap={60} />
        <YAxis
          tickFormatter={(v) => `-${v}%`}
          {...axisProps}
          width={40}
          reversed
        />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(t) => fmt(Number(t))}
          formatter={(v) => [`-${Number(v).toFixed(2)}%`, "drawdown"]}
        />
        <Area
          type="monotone"
          dataKey="dd"
          stroke={NEG}
          fill={NEG}
          fillOpacity={0.12}
          strokeWidth={1}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function Histogram({
  data,
  height = 140,
  xLabel = "return",
  pctBuckets = true,
}: {
  data: { bucket: number; count: number }[];
  height?: number;
  xLabel?: string;
  pctBuckets?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: -20 }}>
        <CartesianGrid stroke={LINE} strokeDasharray="2 3" vertical={false} />
        <XAxis
          dataKey="bucket"
          tickFormatter={(v) =>
            pctBuckets ? `${(Number(v) * 100).toFixed(0)}%` : Number(v).toFixed(1)
          }
          {...axisProps}
        />
        <YAxis {...axisProps} width={36} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(v) =>
            `${xLabel} ${pctBuckets ? `${(Number(v) * 100).toFixed(1)}%` : Number(v).toFixed(2)}`
          }
          formatter={(v) => [String(v), "paths"]}
        />
        <Bar dataKey="count" fill={ACCENT} fillOpacity={0.7} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function BandChart({
  paths,
  height = 180,
}: {
  paths: { t: number; p5: number; p25: number; p50: number; p75: number; p95: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={paths} margin={{ top: 4, right: 6, bottom: 0, left: -22 }}>
        <CartesianGrid stroke={LINE} strokeDasharray="2 3" vertical={false} />
        <XAxis dataKey="t" {...axisProps} label={undefined} />
        <YAxis tickFormatter={(v) => `${Number(v).toFixed(1)}x`} {...axisProps} width={42} />
        <Tooltip
          {...tooltipStyle}
          formatter={(v, name) => [`${Number(v).toFixed(2)}x`, String(name)]}
          labelFormatter={(t) => `trade #${t}`}
        />
        <ReferenceLine y={1} stroke={FAINT} strokeDasharray="3 3" />
        <Area type="monotone" dataKey="p95" stroke={POS} fill={POS} fillOpacity={0.06} strokeWidth={0.8} isAnimationActive={false} />
        <Area type="monotone" dataKey="p75" stroke={POS} fill={POS} fillOpacity={0.1} strokeWidth={0.8} isAnimationActive={false} />
        <Area type="monotone" dataKey="p50" stroke={INK} fill="transparent" strokeWidth={1.4} isAnimationActive={false} />
        <Area type="monotone" dataKey="p25" stroke={NEG} fill={NEG} fillOpacity={0.1} strokeWidth={0.8} isAnimationActive={false} />
        <Area type="monotone" dataKey="p5" stroke={NEG} fill={NEG} fillOpacity={0.06} strokeWidth={0.8} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
