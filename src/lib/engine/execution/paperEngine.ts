// Paper execution engine — simulates limit/market orders against the real
// order book. Pure functions over (order, book): the server store applies the
// returned mutations, so everything here is deterministic and unit-testable.

import type {
  FillRecord,
  OrderBookData,
  PaperOrder,
  PositionRecord,
} from "@/lib/types";
import { genId } from "@/lib/utils";

export interface MatchResult {
  order: PaperOrder;
  fills: FillRecord[];
}

/**
 * Try to (partially) fill an order against a book snapshot.
 * BUY limit: consumes asks priced <= limit. SELL limit: consumes bids >= limit.
 * Market orders walk the whole book.
 */
export function matchOrder(
  order: PaperOrder,
  book: OrderBookData,
  feeRateBps: number,
  now = Date.now(),
): MatchResult {
  if (
    order.status !== "open" &&
    order.status !== "created" &&
    order.status !== "partially_filled"
  ) {
    return { order, fills: [] };
  }
  if (order.expiresAt && now > order.expiresAt) {
    return {
      order: { ...order, status: "expired", updatedAt: now },
      fills: [],
    };
  }

  const levels = order.side === "BUY" ? book.asks : book.bids;
  const limitOk = (price: number) =>
    order.orderType === "market"
      ? true
      : order.side === "BUY"
        ? price <= order.price
        : price >= order.price;

  let remaining = order.size - order.filledSize;
  const fills: FillRecord[] = [];
  let filledNotional = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    if (!limitOk(level.price)) break;
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    const fee = take * level.price * (feeRateBps / 10_000);
    fills.push({
      id: genId("fill"),
      orderId: order.id,
      mode: order.mode,
      tokenId: order.tokenId,
      outcome: order.outcome,
      marketTitle: order.marketTitle,
      category: order.category,
      conditionId: order.conditionId,
      side: order.side,
      price: level.price,
      size: take,
      fee,
      ts: now,
    });
    filledNotional += take * level.price;
    remaining -= take;
  }

  const newFilled = order.size - remaining;
  const prevNotional = (order.avgFillPrice ?? 0) * order.filledSize;
  const avgFillPrice =
    newFilled > 0 ? (prevNotional + filledNotional) / newFilled : undefined;

  const status =
    remaining <= 0
      ? "filled"
      : newFilled > order.filledSize || order.filledSize > 0
        ? "partially_filled"
        : "open";

  return {
    order: {
      ...order,
      filledSize: newFilled,
      avgFillPrice,
      status,
      updatedAt: now,
    },
    fills,
  };
}

export interface PositionUpdate {
  position: PositionRecord;
  cashDelta: number;
  realizedPnlDelta: number;
}

/**
 * Apply a fill to a position with average-cost accounting.
 * BUY: cash out, average price updates. SELL: cash in, realized PnL against
 * the average cost of the shares sold.
 */
export function applyFillToPosition(
  existing: PositionRecord | undefined,
  fill: FillRecord,
): PositionUpdate {
  const pos: PositionRecord = existing ?? {
    tokenId: fill.tokenId,
    mode: fill.mode,
    conditionId: fill.conditionId,
    outcome: fill.outcome,
    marketTitle: fill.marketTitle,
    category: fill.category,
    size: 0,
    avgPrice: 0,
    realizedPnl: 0,
    updatedAt: fill.ts,
  };

  if (fill.side === "BUY") {
    const newSize = pos.size + fill.size;
    const newAvg =
      newSize > 0 ? (pos.avgPrice * pos.size + fill.price * fill.size) / newSize : 0;
    return {
      position: { ...pos, size: newSize, avgPrice: newAvg, updatedAt: fill.ts },
      cashDelta: -(fill.price * fill.size + fill.fee),
      realizedPnlDelta: 0,
    };
  }

  // SELL — realize PnL on the sold shares
  const sold = Math.min(pos.size, fill.size);
  const realized = (fill.price - pos.avgPrice) * sold - fill.fee;
  const newSize = pos.size - sold;
  return {
    position: {
      ...pos,
      size: newSize,
      avgPrice: newSize > 0 ? pos.avgPrice : 0,
      realizedPnl: pos.realizedPnl + realized,
      updatedAt: fill.ts,
    },
    cashDelta: fill.price * sold - fill.fee,
    realizedPnlDelta: realized,
  };
}
