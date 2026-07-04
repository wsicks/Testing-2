"use client";

// Selected-market workspace: price chart, order book depth, trades, rules,
// order ticket, execution cycle, and the explainable decision tree — all
// driven by the same detail query + ticket state.

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useCandles, useMarketDetail } from "@/hooks/api";
import { useClobWs } from "@/hooks/useClobWs";
import { computeMicroMetrics } from "@/lib/engine/micro/microstructure";
import { parseCryptoThreshold } from "@/lib/engine/crossvenue/threshold";
import { fmtCents, fmtDateTime, fmtPrice, fmtTimeUntil, fmtUsd } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Num } from "@/components/ui/num";
import { Button } from "@/components/ui/button";
import { EmptyNote, Spinner } from "@/components/ui/spinner";
import { PriceChart, DepthChart } from "./charts";
import { BookLadder, TradesList } from "./BookPanel";
import { OrderTicket, ticketStages, type TicketState } from "./OrderTicket";
import { ExecutionCycle } from "./ExecutionCycle";

// React Flow is heavy — load it lazily so the dashboard shell stays small
const DecisionTree = dynamic(
  () => import("./DecisionTree").then((m) => m.DecisionTree),
  { ssr: false, loading: () => <Panel title="strategy decision tree"><EmptyNote>loading…</EmptyNote></Panel> },
);
// Lightweight Charts touches window — client-only
const LwChart = dynamic(() => import("./LwChart").then((m) => m.LwChart), {
  ssr: false,
  loading: () => <EmptyNote>loading chart…</EmptyNote>,
});

const INTERVALS = ["1d", "1w", "1m", "max"] as const;

export function MarketWorkspace({
  conditionId,
  full = false,
}: {
  conditionId?: string;
  full?: boolean;
}) {
  const [interval, setInterval] = useState<(typeof INTERVALS)[number]>("1w");
  const { data, isLoading } = useMarketDetail(conditionId, interval);
  const [ticket, setTicket] = useState<TicketState>({ previewing: false });
  const m = data?.market;
  const isAsset = m?.outcomeType === "asset";
  // live book deltas straight from the public CLOB websocket — Polymarket
  // tokens only (Kalshi/Coinbase stream support is polled REST for now)
  const { book: liveBook, wsStatus } = useClobWs(
    m?.venueId === "polymarket" ? m?.yesTokenId : undefined,
  );
  const yesBook = liveBook ?? data?.yesBook;
  const micro =
    yesBook && !isAsset ? computeMicroMetrics(yesBook, data?.trades ?? []) : null;

  // crypto-linked event market → Coinbase spot overlay + threshold line
  const threshold = useMemo(
    () => (m && !isAsset ? parseCryptoThreshold(m.question, m.endDate) : null),
    [m, isAsset],
  );
  const { data: assetCandles } = useCandles(
    isAsset ? m?.conditionId : undefined,
    60,
    7 * 86_400,
  );
  const { data: overlayCandles } = useCandles(
    threshold?.coinbaseProduct ? `cb:${threshold.coinbaseProduct}` : undefined,
    60,
    7 * 86_400,
  );
  const probCandles = useMemo(
    () =>
      (data?.history ?? []).map((p) => ({ t: p.t, o: p.p, h: p.p, l: p.p, c: p.p, v: 0 })),
    [data?.history],
  );
  const spotOverlay = useMemo(
    () =>
      overlayCandles?.candles.length
        ? [
            {
              label: `Coinbase ${threshold?.coinbaseProduct} (reference)`,
              color: "#b45309",
              points: overlayCandles.candles.map((c) => ({ t: c.t, v: c.c })),
            },
          ]
        : [],
    [overlayCandles, threshold?.coinbaseProduct],
  );

  if (!conditionId) {
    return (
      <Panel title="selected market">
        <EmptyNote>select a market in the scanner</EmptyNote>
      </Panel>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">
      {/* left 2/3: market data */}
      <div className="space-y-2 xl:col-span-2">
        <Panel
          title={
            m ? (
              <span className="normal-case tracking-normal text-ink">
                {m.question}
              </span>
            ) : (
              "loading market…"
            )
          }
          right={
            <>
              {isLoading ? <Spinner /> : null}
              {m ? (
                <>
                  <Badge variant={m.venueId === "polymarket" ? "accent" : m.venueId === "kalshi" ? "pos" : "warn"}>
                    {m.venueId}
                  </Badge>
                  {m.referenceOnly ? <Badge variant="warn">reference-only</Badge> : null}
                  <Badge
                    variant={
                      m.tradability === "tradable"
                        ? "pos"
                        : m.tradability === "caution"
                          ? "warn"
                          : "neg"
                    }
                  >
                    {m.riskGrade} · {m.tradability}
                  </Badge>
                  {(data?.polymarketUrl ?? m.sourceUrl) ? (
                    <a
                      href={data?.polymarketUrl ?? m.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-2xs text-accent hover:underline"
                    >
                      {m.venueId} ↗
                    </a>
                  ) : null}
                </>
              ) : null}
            </>
          }
          bodyClassName="p-0"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-paper px-2 py-1 text-2xs">
            <Stat label={isAsset ? "price" : "yes"} v={fmtPrice(m?.yesPrice, m?.outcomeType)} />
            {!isAsset ? <Stat label="no" v={fmtPrice(m?.noPrice, m?.outcomeType)} /> : null}
            <Stat label="bid" v={fmtPrice(yesBook?.bestBid ?? m?.bestBid, m?.outcomeType)} tone="pos" />
            <Stat label="ask" v={fmtPrice(yesBook?.bestAsk ?? m?.bestAsk, m?.outcomeType)} tone="neg" />
            <Stat label="spread" v={fmtPrice(yesBook?.spread ?? m?.spread, m?.outcomeType)} />
            <Stat label="liquidity" v={fmtUsd(m?.liquidity, 0)} />
            <Stat label="vol 24h" v={fmtUsd(m?.volume24h, 0)} />
            <Stat
              label="closes"
              v={isAsset ? "continuous" : `${fmtTimeUntil(m?.endDate)} (${fmtDateTime(m?.endDate)})`}
            />
            <div className="ml-auto flex gap-0.5">
              {INTERVALS.map((i) => (
                <Button
                  key={i}
                  size="xs"
                  variant={interval === i ? "primary" : "ghost"}
                  onClick={() => setInterval(i)}
                >
                  {i}
                </Button>
              ))}
            </div>
          </div>
          <div className="p-1">
            {isAsset ? (
              assetCandles?.candles.length ? (
                <LwChart
                  candles={assetCandles.candles}
                  mode="candles"
                  height={full ? 280 : 220}
                />
              ) : (
                <EmptyNote>loading candles…</EmptyNote>
              )
            ) : threshold && probCandles.length ? (
              <>
                <LwChart
                  candles={probCandles}
                  mode="probability"
                  overlays={spotOverlay}
                  threshold={undefined}
                  height={full ? 280 : 220}
                />
                <div className="px-1 pt-0.5 text-3xs text-ink-faint">
                  probability (left, blue) vs Coinbase {threshold.coinbaseProduct} spot
                  (right, amber, reference-only) — threshold ${threshold.threshold.toLocaleString()} {threshold.direction}
                </div>
              </>
            ) : data?.history?.length ? (
              <PriceChart history={data.history} height={full ? 260 : 200} />
            ) : (
              <EmptyNote>no price history</EmptyNote>
            )}
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <Panel
            title="order book (yes)"
            bodyClassName="p-1.5"
            right={
              wsStatus === "live" ? (
                <Badge variant="pos">live ws</Badge>
              ) : wsStatus === "connecting" ? (
                <Badge>ws…</Badge>
              ) : (
                <Badge>polled</Badge>
              )
            }
          >
            <BookLadder book={yesBook} outcomeType={m?.outcomeType} />
          </Panel>
          <Panel title="depth & microstructure" bodyClassName="p-1">
            {yesBook ? (
              <DepthChart bids={yesBook.bids} asks={yesBook.asks} />
            ) : (
              <EmptyNote>no book</EmptyNote>
            )}
            <div className="mt-1 grid grid-cols-2 gap-1 text-2xs">
              <div className="border border-line bg-paper px-1.5 py-0.5">
                <span className="label">bid depth ±5c</span>{" "}
                <Num tone="pos">{fmtUsd(yesBook?.bidDepthUsd, 0)}</Num>
              </div>
              <div className="border border-line bg-paper px-1.5 py-0.5">
                <span className="label">ask depth ±5c</span>{" "}
                <Num tone="neg">{fmtUsd(yesBook?.askDepthUsd, 0)}</Num>
              </div>
              {micro ? (
                <>
                  <div className="border border-line bg-paper px-1.5 py-0.5">
                    <span className="label">micro-price</span>{" "}
                    <Num tone={micro.microDivergence}>
                      {fmtCents(micro.microPrice)} ({micro.microDivergence >= 0 ? "+" : ""}
                      {(micro.microDivergence * 100).toFixed(2)}c)
                    </Num>
                  </div>
                  <div className="border border-line bg-paper px-1.5 py-0.5">
                    <span className="label">book / tape lean</span>{" "}
                    <Num tone={micro.bookImbalance}>{(micro.bookImbalance * 100).toFixed(0)}%</Num>
                    {" / "}
                    <Num tone={micro.tapeImbalance}>{(micro.tapeImbalance * 100).toFixed(0)}%</Num>
                  </div>
                  <div className="col-span-2 border border-line bg-paper px-1.5 py-0.5">
                    <span className="label">flow pressure</span>
                    <div className="relative mt-0.5 h-2 border border-line bg-panel">
                      <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
                      <div
                        className={micro.pressure >= 0 ? "absolute inset-y-0 bg-pos/40" : "absolute inset-y-0 bg-neg/40"}
                        style={
                          micro.pressure >= 0
                            ? { left: "50%", width: `${(micro.pressure * 50).toFixed(1)}%` }
                            : { right: "50%", width: `${(-micro.pressure * 50).toFixed(1)}%` }
                        }
                      />
                    </div>
                    <div className="flex justify-between text-3xs text-ink-faint">
                      <span>sell pressure</span>
                      <Num tone={micro.pressure}>{(micro.pressure * 100).toFixed(0)}%</Num>
                      <span>buy pressure</span>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </Panel>
          <Panel title="recent trades" bodyClassName="p-1.5">
            <TradesList trades={data?.trades ?? []} outcomeType={m?.outcomeType} />
          </Panel>
        </div>

        <Panel title="market rules / resolution" bodyClassName="max-h-40 overflow-y-auto">
          {m?.description ? (
            <p className="whitespace-pre-wrap text-2xs leading-snug text-ink-soft">
              {m.description}
            </p>
          ) : (
            <EmptyNote>no resolution text provided — treat as high ambiguity</EmptyNote>
          )}
          <div className="mt-2 grid grid-cols-1 gap-0.5 border-t border-line pt-1 text-3xs text-ink-faint">
            <span>condition id: <span className="num">{m?.conditionId}</span></span>
            <span>yes token: <span className="num">{m?.yesTokenId}</span></span>
            <span>no token: <span className="num">{m?.noTokenId}</span></span>
          </div>
        </Panel>
      </div>

      {/* right 1/3: trade workflow */}
      <div className="space-y-2">
        <OrderTicket detail={data} onState={setTicket} />
        <ExecutionCycle stages={ticketStages(Boolean(data), ticket)} />
        <DecisionTree
          marketTitle={m?.question}
          assessment={ticket.assessment}
          signal={data?.signals?.[0]}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  v,
  tone,
}: {
  label: string;
  v: React.ReactNode;
  tone?: "pos" | "neg";
}) {
  return (
    <span className="flex items-center gap-1">
      <span className="label">{label}</span>
      <Num tone={tone}>{v}</Num>
    </span>
  );
}
