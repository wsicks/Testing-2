// Integration tests for the Data API adapter with recorded fixtures.

import { describe, expect, it } from "vitest";
import {
  fetchRecentTrades,
  fetchUserPositions,
  fetchUserValue,
} from "@/lib/polymarket/dataapi";
import { stubFetch } from "../helpers";

describe("data api adapter", () => {
  it("maps the public trade tape (seconds → ms, side, outcome)", async () => {
    const fetchFn = stubFetch([
      {
        match: (u) => u.includes("/trades"),
        body: [
          {
            proxyWallet: "0xabc",
            side: "BUY",
            asset: "1026464",
            conditionId: "0x35b972",
            size: 6,
            price: 0.76,
            timestamp: 1_783_182_532,
            title: "Test market",
            outcome: "Yes",
          },
        ],
      },
    ]);
    const trades = await fetchRecentTrades("0x35b972", 10, { fetchFn });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toEqual({
      side: "BUY",
      price: 0.76,
      size: 6,
      ts: 1_783_182_532_000,
      outcome: "Yes",
    });
  });

  it("passes the condition id as the market param", async () => {
    let url = "";
    const fetchFn = stubFetch([
      {
        match: (u) => {
          url = u;
          return true;
        },
        body: [],
      },
    ]);
    await fetchRecentTrades("0xcond", 5, { fetchFn });
    expect(url).toContain("market=0xcond");
    expect(url).toContain("limit=5");
  });

  it("fetches read-only user positions", async () => {
    const fetchFn = stubFetch([
      {
        match: (u) => u.includes("/positions") && u.includes("user=0xwallet"),
        body: [
          {
            asset: "111",
            conditionId: "0xc",
            size: 100,
            avgPrice: 0.4,
            initialValue: 40,
            currentValue: 55,
            cashPnl: 15,
            percentPnl: 37.5,
            curPrice: 0.55,
            title: "Held market",
            outcome: "Yes",
          },
        ],
      },
    ]);
    const pos = await fetchUserPositions("0xwallet", { fetchFn });
    expect(pos).toHaveLength(1);
    expect(pos[0].curPrice).toBe(0.55);
  });

  it("extracts portfolio value", async () => {
    const fetchFn = stubFetch([
      {
        match: (u) => u.includes("/value"),
        body: [{ user: "0xwallet", value: 1234.56 }],
      },
    ]);
    expect(await fetchUserValue("0xwallet", { fetchFn })).toBeCloseTo(1234.56, 2);
  });

  it("returns undefined value on empty responses", async () => {
    const fetchFn = stubFetch([{ match: (u) => u.includes("/value"), body: [] }]);
    expect(await fetchUserValue("0xwallet", { fetchFn })).toBeUndefined();
  });
});
