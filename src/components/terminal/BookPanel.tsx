"use client";

// Order book ladder + recent trades for the selected market.

import type { OrderBookData, RecentTrade } from "@/lib/types";
import { fmtNum, fmtPrice, fmtTime } from "@/lib/format";
import { Num } from "@/components/ui/num";
import { Badge } from "@/components/ui/badge";
import { EmptyNote } from "@/components/ui/spinner";

export function BookLadder({
  book,
  levels = 8,
  outcomeType = "binary",
}: {
  book?: OrderBookData;
  levels?: number;
  outcomeType?: "binary" | "asset";
}) {
  if (!book) return <EmptyNote>no book data</EmptyNote>;
  const asks = book.asks.slice(0, levels).reverse();
  const bids = book.bids.slice(0, levels);
  const maxSize = Math.max(
    1,
    ...asks.map((l) => l.size),
    ...bids.map((l) => l.size),
  );
  return (
    <div className="text-2xs">
      {book.source === "mock" ? (
        <div className="mb-1">
          <Badge variant="warn">mock order book</Badge>
        </div>
      ) : null}
      <div className="grid grid-cols-3 border-b border-line pb-0.5">
        <span className="label">price</span>
        <span className="label text-right">size</span>
        <span className="label text-right">total $</span>
      </div>
      {asks.map((l, i) => (
        <div key={`a${i}`} className="relative grid grid-cols-3 py-px">
          <div
            className="absolute inset-y-0 right-0 bg-neg-soft"
            style={{ width: `${(l.size / maxSize) * 100}%` }}
          />
          <Num tone="neg" className="relative">{fmtPrice(l.price, outcomeType)}</Num>
          <Num className="relative text-right">{fmtNum(l.size)}</Num>
          <Num className="relative text-right text-ink-faint">
            {fmtNum(l.price * l.size)}
          </Num>
        </div>
      ))}
      <div className="my-0.5 flex items-center justify-between border-y border-line bg-paper px-1 py-0.5">
        <span className="label">spread</span>
        <Num tone={book.spread !== undefined && book.spread > 0.03 ? "warn" : undefined}>
          {fmtPrice(book.spread, outcomeType)}
        </Num>
        <span className="label">mid</span>
        <Num>{fmtPrice(book.midpoint, outcomeType)}</Num>
      </div>
      {bids.map((l, i) => (
        <div key={`b${i}`} className="relative grid grid-cols-3 py-px">
          <div
            className="absolute inset-y-0 right-0 bg-pos-soft"
            style={{ width: `${(l.size / maxSize) * 100}%` }}
          />
          <Num tone="pos" className="relative">{fmtPrice(l.price, outcomeType)}</Num>
          <Num className="relative text-right">{fmtNum(l.size)}</Num>
          <Num className="relative text-right text-ink-faint">
            {fmtNum(l.price * l.size)}
          </Num>
        </div>
      ))}
    </div>
  );
}

export function TradesList({
  trades,
  outcomeType = "binary",
}: {
  trades: RecentTrade[];
  outcomeType?: "binary" | "asset";
}) {
  if (!trades.length) return <EmptyNote>no recent trades reported</EmptyNote>;
  return (
    <div className="max-h-48 overflow-y-auto text-2xs">
      <div className="grid grid-cols-4 border-b border-line pb-0.5">
        <span className="label">time</span>
        <span className="label">side</span>
        <span className="label text-right">price</span>
        <span className="label text-right">size</span>
      </div>
      {trades.map((t, i) => (
        <div key={i} className="grid grid-cols-4 border-b border-line/50 py-px">
          <Num className="text-ink-faint">{fmtTime(t.ts)}</Num>
          <Num tone={t.side === "BUY" ? "pos" : "neg"}>
            {t.side} {t.outcome ?? ""}
          </Num>
          <Num className="text-right">{fmtPrice(t.price, outcomeType)}</Num>
          <Num className="text-right">{fmtNum(t.size)}</Num>
        </div>
      ))}
    </div>
  );
}
