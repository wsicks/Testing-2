"use client";

// Live order-book stream for the selected market — direct browser connection
// to Polymarket's public CLOB market websocket. Sends full book snapshots on
// subscribe and price_change deltas afterward; we apply deltas in place and
// batch UI updates per animation frame. Falls back silently to HTTP polling
// (the existing query) if the socket can't connect.

import { useEffect, useRef, useState } from "react";
import { CLOB_WS_URL } from "@/lib/constants";
import type { BookLevel, OrderBookData } from "@/lib/types";

interface WsBookMsg {
  event_type: "book";
  asset_id: string;
  bids?: { price: string; size: string }[];
  asks?: { price: string; size: string }[];
  buys?: { price: string; size: string }[];
  sells?: { price: string; size: string }[];
  timestamp?: string;
}

interface WsPriceChangeMsg {
  event_type: "price_change";
  asset_id: string;
  changes?: { price: string; side: "BUY" | "SELL"; size: string }[];
  price?: string;
  side?: "BUY" | "SELL";
  size?: string;
  timestamp?: string;
}

function toLevels(raw: { price: string; size: string }[] | undefined, desc: boolean): BookLevel[] {
  return (raw ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
}

function finalize(tokenId: string, bids: BookLevel[], asks: BookLevel[]): OrderBookData {
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const midpoint =
    bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk;
  const band = (levels: BookLevel[]) =>
    midpoint === undefined
      ? 0
      : levels.reduce((a, l) => (Math.abs(l.price - midpoint) <= 0.05 ? a + l.price * l.size : a), 0);
  return {
    tokenId,
    bids,
    asks,
    bestBid,
    bestAsk,
    midpoint,
    spread: bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined,
    bidDepthUsd: band(bids),
    askDepthUsd: band(asks),
    ts: Date.now(),
    source: "clob",
  };
}

export function useClobWs(tokenId?: string): {
  book?: OrderBookData;
  wsStatus: "off" | "connecting" | "live" | "error";
} {
  const [book, setBook] = useState<OrderBookData>();
  const [wsStatus, setWsStatus] = useState<"off" | "connecting" | "live" | "error">("off");
  const stateRef = useRef<{ bids: Map<number, number>; asks: Map<number, number> }>({
    bids: new Map(),
    asks: new Map(),
  });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!tokenId || tokenId.startsWith("mocktok")) {
      setBook(undefined);
      setWsStatus("off");
      return;
    }
    setWsStatus("connecting");
    let ws: WebSocket | null = null;
    let closed = false;

    const publish = () => {
      rafRef.current = null;
      const s = stateRef.current;
      const bids = [...s.bids.entries()]
        .map(([price, size]) => ({ price, size }))
        .sort((a, b) => b.price - a.price);
      const asks = [...s.asks.entries()]
        .map(([price, size]) => ({ price, size }))
        .sort((a, b) => a.price - b.price);
      setBook(finalize(tokenId, bids, asks));
    };
    const schedule = () => {
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(publish);
    };

    try {
      ws = new WebSocket(CLOB_WS_URL);
      ws.onopen = () => {
        ws?.send(JSON.stringify({ assets_ids: [tokenId], type: "market" }));
        setWsStatus("live");
      };
      ws.onmessage = (msg) => {
        let data: unknown;
        try {
          data = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        const events = Array.isArray(data) ? data : [data];
        for (const evt of events as (WsBookMsg | WsPriceChangeMsg)[]) {
          if (!evt || typeof evt !== "object") continue;
          if (evt.asset_id !== tokenId) continue;
          if (evt.event_type === "book") {
            const b = evt as WsBookMsg;
            const bids = toLevels(b.bids ?? b.buys, true);
            const asks = toLevels(b.asks ?? b.sells, false);
            stateRef.current = {
              bids: new Map(bids.map((l) => [l.price, l.size])),
              asks: new Map(asks.map((l) => [l.price, l.size])),
            };
            schedule();
          } else if (evt.event_type === "price_change") {
            const p = evt as WsPriceChangeMsg;
            const changes = p.changes ?? [
              { price: p.price ?? "", side: p.side ?? "BUY", size: p.size ?? "" },
            ];
            for (const ch of changes) {
              const price = Number(ch.price);
              const size = Number(ch.size);
              if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
              const side = ch.side === "BUY" ? stateRef.current.bids : stateRef.current.asks;
              if (size <= 0) side.delete(price);
              else side.set(price, size);
            }
            schedule();
          }
        }
      };
      ws.onerror = () => {
        if (!closed) setWsStatus("error");
      };
      ws.onclose = () => {
        if (!closed) setWsStatus("error");
      };
    } catch {
      setWsStatus("error");
    }

    return () => {
      closed = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      ws?.close();
      setBook(undefined);
      setWsStatus("off");
    };
  }, [tokenId]);

  return { book, wsStatus };
}
