"use client";

// TradingView Lightweight Charts (Apache-2.0, v5 API) rendering OUR OWN
// normalized backend data — candles for spot products, probability lines for
// event markets, with optional overlays: a second-venue probability line, a
// Coinbase spot series on its own scale, and a threshold price line. All
// series are labeled with their source; nothing here embeds TradingView
// widget data.

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { NormalizedCandle } from "@/lib/types";

export interface LwOverlayLine {
  label: string;
  color: string;
  /** render on the left scale (0–100 probability) instead of the right */
  probability?: boolean;
  points: { t: number; v: number }[];
}

// module-level constant: a `= []` default parameter allocates a NEW array
// every render, and it sits in the chart effect's dependency array — the
// chart would be torn down and rebuilt (losing zoom/pan) on every parent
// render
const NO_OVERLAYS: LwOverlayLine[] = [];

export function LwChart({
  candles,
  mode,
  overlays = NO_OVERLAYS,
  threshold,
  height = 260,
}: {
  candles: NormalizedCandle[];
  /** candlestick for asset products, line for probability series */
  mode: "candles" | "probability";
  overlays?: LwOverlayLine[];
  /** horizontal reference line (USD for candles, 0–1 for probability) */
  threshold?: { value: number; label: string };
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: "#fffdf9" },
        textColor: "#8a8272",
        fontSize: 10,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      grid: {
        vertLines: { color: "#efe9dd" },
        horzLines: { color: "#efe9dd" },
      },
      rightPriceScale: { borderColor: "#e4ded1" },
      leftPriceScale: {
        visible: overlays.some((o) => o.probability) || mode === "probability",
        borderColor: "#e4ded1",
      },
      timeScale: { borderColor: "#e4ded1", timeVisible: true },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    if (mode === "candles") {
      const series = chart.addSeries(CandlestickSeries, {
        upColor: "#15803d",
        downColor: "#b91c1c",
        wickUpColor: "#15803d",
        wickDownColor: "#b91c1c",
        borderVisible: false,
      });
      series.setData(
        candles.map((c) => ({
          time: c.t as UTCTimestamp,
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
        })),
      );
      if (threshold) {
        series.createPriceLine({
          price: threshold.value,
          color: "#b45309",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: threshold.label,
        });
      }
    } else {
      const series = chart.addSeries(LineSeries, {
        color: "#1d4ed8",
        lineWidth: 2,
        priceScaleId: "left",
        priceFormat: { type: "custom", formatter: (p: number) => `${(p * 100).toFixed(1)}%` },
      });
      series.setData(
        candles.map((c) => ({ time: c.t as UTCTimestamp, value: c.c })),
      );
      if (threshold) {
        series.createPriceLine({
          price: threshold.value,
          color: "#b45309",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: threshold.label,
        });
      }
    }

    for (const o of overlays) {
      const s = chart.addSeries(LineSeries, {
        color: o.color,
        lineWidth: 1,
        priceScaleId: o.probability ? "left" : "right",
        title: o.label,
        priceFormat: o.probability
          ? { type: "custom", formatter: (p: number) => `${(p * 100).toFixed(1)}%` }
          : undefined,
      });
      s.setData(o.points.map((p) => ({ time: p.t as UTCTimestamp, value: p.v })));
    }

    chart.timeScale().fitContent();
    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, mode, overlays, threshold, height]);

  return <div ref={ref} className="w-full" style={{ height }} />;
}
