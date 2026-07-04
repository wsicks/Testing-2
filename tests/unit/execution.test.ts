// Orchestration tests for the paper execution layer against the real
// MemoryStore, with market data fully mocked. Covers the end-to-end
// place→fill→position→cash flow, rejection, cancel-all, and a regression
// test for the concurrent-settlement double-fill race.

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NormalizedMarket, OrderBookData } from "@/lib/types";
import { makeBook, makeMarket } from "../helpers";

// mutable fixtures the mocked marketData serves
const fixtures: { market: NormalizedMarket; book: OrderBookData } = {
  market: makeMarket(),
  book: makeBook(),
};

vi.mock("@/server/marketData", () => ({
  getMarkets: async () => ({
    markets: [fixtures.market],
    source: "gamma" as const,
    fetchedAt: Date.now(),
  }),
  getMarketByCondition: async (id: string) =>
    id === fixtures.market.conditionId ? fixtures.market : undefined,
  getMarketByToken: async (tokenId: string) =>
    fixtures.market.yesTokenId === tokenId || fixtures.market.noTokenId === tokenId
      ? fixtures.market
      : undefined,
  getBook: async () => fixtures.book,
  getHistory: async () => [],
  getTrades: async () => [],
  priceLookup: async () =>
    new Map<string, number>([
      [fixtures.market.yesTokenId!, fixtures.market.yesPrice ?? 0.5],
      [fixtures.market.noTokenId!, fixtures.market.noPrice ?? 0.5],
    ]),
  isMockToken: (t: string) => t.startsWith("mocktok"),
}));

import {
  cancelAllOrders,
  placePaperOrder,
  previewTrade,
  settleOpenOrders,
} from "@/server/execution";
import { getStore } from "@/server/store";

const base = {
  mode: "paper" as const,
  conditionId: "0xcond1",
  tokenId: "tok-yes",
  outcome: "Yes",
  side: "BUY" as const,
  orderType: "limit" as const,
  price: 0.56,
  size: 10,
  winProbability: 0.65,
};

beforeAll(async () => {
  const store = await getStore();
  await store.resetMode("paper");
  // freshen fixture timestamps for the data-freshness risk check
  fixtures.market = makeMarket();
  fixtures.book = makeBook();
});

describe("paper execution orchestration", () => {
  it("previews without creating an order", async () => {
    const { assessment } = await previewTrade(base);
    expect(assessment.approved).toBe(true);
    const store = await getStore();
    expect(await store.listOrders("paper")).toHaveLength(0);
  });

  it("places, fills against the book, and updates position + cash", async () => {
    const store = await getStore();
    const cashBefore = (await store.getAccount("paper")).cash;
    const res = await placePaperOrder(base);
    expect(res.rejected).toBe(false);
    expect(res.order?.status).toBe("filled");
    expect(res.order?.avgFillPrice).toBeCloseTo(0.56, 6); // best ask level

    const pos = await store.getPosition("tok-yes", "paper");
    expect(pos?.size).toBe(10);
    const cashAfter = (await store.getAccount("paper")).cash;
    expect(cashBefore - cashAfter).toBeCloseTo(0.56 * 10, 6);
  });

  it("rejects blocked trades without creating an order", async () => {
    const store = await getStore();
    const before = (await store.listOrders("paper")).length;
    const res = await placePaperOrder({ ...base, size: 100_000 }); // size cap
    expect(res.rejected).toBe(true);
    expect(res.order).toBeUndefined();
    expect((await store.listOrders("paper")).length).toBe(before);
  });

  it("rests non-marketable limits, then settles them exactly once under concurrency", async () => {
    const store = await getStore();
    // passive bid far below the ask — rests open
    const res = await placePaperOrder({ ...base, price: 0.4, size: 20, winProbability: 0.65 });
    expect(res.order?.status).toBe("open");
    const posBefore = (await store.getPosition("tok-yes", "paper"))?.size ?? 0;

    // market collapses: asks now cross the resting 40c limit
    fixtures.book = makeBook({
      asks: [{ price: 0.38, size: 500 }],
      bestAsk: 0.38,
      bids: [{ price: 0.36, size: 500 }],
      bestBid: 0.36,
      midpoint: 0.37,
      spread: 0.02,
    });

    // the regression: two concurrent settlement passes must not double-fill
    await Promise.all([settleOpenOrders("paper"), settleOpenOrders("paper")]);

    const order = (await store.listOrders("paper")).find((o) => o.id === res.order!.id);
    expect(order?.status).toBe("filled");
    const posAfter = (await store.getPosition("tok-yes", "paper"))?.size ?? 0;
    expect(posAfter - posBefore).toBe(20); // exactly once, not 40

    const fills = await store.listFills("paper");
    const orderFills = fills.filter((f) => f.orderId === res.order!.id);
    expect(orderFills.reduce((a, f) => a + f.size, 0)).toBe(20);
  });

  it("cancel-all cancels every open order and nothing else", async () => {
    const store = await getStore();
    fixtures.book = makeBook(); // restore normal book
    const resting = await placePaperOrder({ ...base, price: 0.3, size: 5 });
    expect(resting.order?.status).toBe("open");
    const canceled = await cancelAllOrders("paper");
    expect(canceled).toBeGreaterThanOrEqual(1);
    const orders = await store.listOrders("paper");
    expect(orders.every((o) => !["open", "created", "partially_filled"].includes(o.status))).toBe(true);
    // previously-filled orders are untouched
    expect(orders.some((o) => o.status === "filled")).toBe(true);
  });
});
