// Integration tests for the CLOB read adapter with recorded fixtures.

import { describe, expect, it } from "vitest";
import {
  depthWithinBand,
  fetchBestPrice,
  fetchMidpoint,
  fetchOrderBook,
  fetchPriceHistory,
  fetchSpread,
  normalizeBook,
  type RawOrderBook,
} from "@/lib/polymarket/clob";
import { stubFetch } from "../helpers";

// verbatim shape from the production /book endpoint (bids/asks worst-first)
const rawBook: RawOrderBook = {
  market: "0x7412d284",
  asset_id: "30499731947464",
  timestamp: "1783182729680",
  hash: "6b033f7a",
  bids: [
    { price: "0.001", size: "2638699.45" },
    { price: "0.44", size: "100" },
    { price: "0.45", size: "250" },
  ],
  asks: [
    { price: "0.999", size: "19393116.22" },
    { price: "0.48", size: "300" },
    { price: "0.47", size: "120" },
  ],
};

describe("book normalization", () => {
  it("sorts to best-first and derives bbo/mid/spread", () => {
    const book = normalizeBook(rawBook);
    expect(book.bids[0].price).toBe(0.45);
    expect(book.asks[0].price).toBe(0.47);
    expect(book.bestBid).toBe(0.45);
    expect(book.bestAsk).toBe(0.47);
    expect(book.midpoint).toBeCloseTo(0.46, 6);
    expect(book.spread).toBeCloseTo(0.02, 6);
    expect(book.source).toBe("clob");
  });

  it("computes near-mid depth in USD within the band", () => {
    const book = normalizeBook(rawBook);
    // within 5c of 0.46: bids 0.45×250 + 0.44×100, asks 0.47×120 + 0.48×300
    expect(book.bidDepthUsd).toBeCloseTo(0.45 * 250 + 0.44 * 100, 4);
    expect(book.askDepthUsd).toBeCloseTo(0.47 * 120 + 0.48 * 300, 4);
    expect(depthWithinBand([{ price: 0.9, size: 100 }], 0.46)).toBe(0);
  });

  it("drops non-numeric levels", () => {
    const book = normalizeBook({
      ...rawBook,
      bids: [{ price: "abc", size: "10" }, { price: "0.4", size: "5" }],
    });
    expect(book.bids).toHaveLength(1);
  });
});

describe("clob endpoints", () => {
  it("fetches and normalizes a book", async () => {
    const fetchFn = stubFetch([{ match: (u) => u.includes("/book"), body: rawBook }]);
    const book = await fetchOrderBook("30499731947464", { fetchFn });
    expect(book.tokenId).toBe("30499731947464");
    expect(book.bestBid).toBe(0.45);
  });

  it("parses midpoint / price / spread scalar responses", async () => {
    const fetchFn = stubFetch([
      { match: (u) => u.includes("/midpoint"), body: { mid: "0.0025" } },
      { match: (u) => u.includes("/price"), body: { price: "0.002" } },
      { match: (u) => u.includes("/spread"), body: { spread: "0.001" } },
    ]);
    expect(await fetchMidpoint("t", { fetchFn })).toBeCloseTo(0.0025, 6);
    expect(await fetchBestPrice("t", "buy", { fetchFn })).toBeCloseTo(0.002, 6);
    expect(await fetchSpread("t", { fetchFn })).toBeCloseTo(0.001, 6);
  });

  it("returns sorted, finite price history", async () => {
    const fetchFn = stubFetch([
      {
        match: (u) => u.includes("/prices-history"),
        body: {
          history: [
            { t: 300, p: 0.5 },
            { t: 100, p: 0.4 },
            { t: 200, p: Number.NaN },
          ],
        },
      },
    ]);
    const hist = await fetchPriceHistory("t", { interval: "1d" }, { fetchFn });
    expect(hist).toEqual([
      { t: 100, p: 0.4 },
      { t: 300, p: 0.5 },
    ]);
  });

  it("requests the token via the market query param", async () => {
    let url = "";
    const fetchFn = stubFetch([
      {
        match: (u) => {
          url = u;
          return true;
        },
        body: { history: [] },
      },
    ]);
    await fetchPriceHistory("token123", { interval: "1w", fidelity: 60 }, { fetchFn });
    expect(url).toContain("market=token123");
    expect(url).toContain("interval=1w");
    expect(url).toContain("fidelity=60");
  });
});
