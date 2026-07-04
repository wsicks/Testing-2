import { describe, expect, it } from "vitest";
import {
  applyFillToPosition,
  matchOrder,
} from "@/lib/engine/execution/paperEngine";
import type { FillRecord, PaperOrder } from "@/lib/types";
import { makeBook } from "../helpers";

const now = Date.now();

function makeOrder(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    id: "ord1",
    mode: "paper",
    tokenId: "tok-yes",
    outcome: "Yes",
    side: "BUY",
    orderType: "limit",
    price: 0.57,
    size: 100,
    filledSize: 0,
    status: "created",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("paper matching", () => {
  it("fills a marketable BUY limit against asks up to the limit price", () => {
    // asks: 400 @ .56, 900 @ .57 → 100 shares all fill at .56
    const { order, fills } = matchOrder(makeOrder(), makeBook(), 0, now);
    expect(order.status).toBe("filled");
    expect(order.filledSize).toBe(100);
    expect(fills).toHaveLength(1);
    expect(fills[0].price).toBe(0.56);
    expect(order.avgFillPrice).toBeCloseTo(0.56, 6);
  });

  it("walks multiple levels and averages the fill price", () => {
    const { order, fills } = matchOrder(makeOrder({ size: 600 }), makeBook(), 0, now);
    // 400 @ .56 + 200 @ .57
    expect(order.status).toBe("filled");
    expect(fills).toHaveLength(2);
    expect(order.avgFillPrice).toBeCloseTo((400 * 0.56 + 200 * 0.57) / 600, 6);
  });

  it("partially fills when the limit stops the walk", () => {
    const { order } = matchOrder(makeOrder({ size: 2_000, price: 0.57 }), makeBook(), 0, now);
    // only 400 + 900 available at ≤ .57
    expect(order.status).toBe("partially_filled");
    expect(order.filledSize).toBe(1_300);
  });

  it("leaves non-marketable limits open with no fills", () => {
    const { order, fills } = matchOrder(makeOrder({ price: 0.5 }), makeBook(), 0, now);
    expect(fills).toHaveLength(0);
    expect(order.filledSize).toBe(0);
    expect(["open", "created"]).toContain(order.status);
  });

  it("fills SELL limits against bids", () => {
    const { order, fills } = matchOrder(
      makeOrder({ side: "SELL", price: 0.53 }),
      makeBook(),
      0,
      now,
    );
    expect(order.status).toBe("filled");
    expect(fills[0].price).toBe(0.54); // best bid first
  });

  it("expires stale orders instead of filling them", () => {
    const { order, fills } = matchOrder(
      makeOrder({ expiresAt: now - 1000, status: "open" }),
      makeBook(),
      0,
      now,
    );
    expect(order.status).toBe("expired");
    expect(fills).toHaveLength(0);
  });

  it("charges fees in bps of notional", () => {
    const { fills } = matchOrder(makeOrder(), makeBook(), 100, now); // 1%
    expect(fills[0].fee).toBeCloseTo(100 * 0.56 * 0.01, 6);
  });
});

describe("position accounting", () => {
  const buyFill: FillRecord = {
    id: "f1",
    mode: "paper",
    tokenId: "tok-yes",
    side: "BUY",
    price: 0.5,
    size: 100,
    fee: 0,
    ts: now,
  };

  it("opens and averages long positions", () => {
    const first = applyFillToPosition(undefined, buyFill);
    expect(first.position.size).toBe(100);
    expect(first.position.avgPrice).toBeCloseTo(0.5, 6);
    expect(first.cashDelta).toBeCloseTo(-50, 6);

    const second = applyFillToPosition(first.position, {
      ...buyFill,
      id: "f2",
      price: 0.6,
      size: 100,
    });
    expect(second.position.size).toBe(200);
    expect(second.position.avgPrice).toBeCloseTo(0.55, 6);
  });

  it("realizes pnl on sells against average cost", () => {
    const { position } = applyFillToPosition(undefined, buyFill);
    const sell = applyFillToPosition(position, {
      ...buyFill,
      id: "f3",
      side: "SELL",
      price: 0.62,
      size: 60,
    });
    expect(sell.realizedPnlDelta).toBeCloseTo((0.62 - 0.5) * 60, 6);
    expect(sell.position.size).toBe(40);
    expect(sell.cashDelta).toBeCloseTo(0.62 * 60, 6);
    expect(sell.position.realizedPnl).toBeCloseTo(7.2, 6);
  });

  it("nets fees out of realized pnl and cash", () => {
    const { position } = applyFillToPosition(undefined, buyFill);
    const sell = applyFillToPosition(position, {
      ...buyFill,
      id: "f4",
      side: "SELL",
      price: 0.6,
      size: 100,
      fee: 1.5,
    });
    expect(sell.realizedPnlDelta).toBeCloseTo(10 - 1.5, 6);
    expect(sell.cashDelta).toBeCloseTo(60 - 1.5, 6);
    expect(sell.position.size).toBe(0);
    expect(sell.position.avgPrice).toBe(0);
  });
});
