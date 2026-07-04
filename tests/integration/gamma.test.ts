// Integration tests for the Gamma adapter against recorded response fixtures
// (shape verified against the live production API). Fully offline.

import { describe, expect, it } from "vitest";
import {
  fetchActiveMarkets,
  normalizeGammaMarket,
  pickCategory,
  type GammaEventRaw,
} from "@/lib/polymarket/gamma";
import { PolymarketApiError } from "@/lib/polymarket/http";
import { stubFetch } from "../helpers";

const eventFixture: GammaEventRaw = {
  id: "903193",
  title: "2026 FIFA World Cup Winner",
  slug: "2026-fifa-world-cup-winner",
  active: true,
  closed: false,
  endDate: "2026-07-20T00:00:00Z",
  negRisk: true,
  volume24hr: 1_570_807,
  tags: [
    { id: "1", label: "Hide From New", slug: "hide-from-new" },
    { id: "2", label: "Sports", slug: "sports" },
    { id: "3", label: "FIFA World Cup", slug: "fifa-world-cup" },
  ],
  markets: [
    {
      id: "516721",
      question: "Will Spain win the 2026 FIFA World Cup?",
      conditionId: "0x7976b8db",
      slug: "will-spain-win",
      description:
        "This market will resolve to 'Yes' if Spain wins the 2026 FIFA World Cup. The resolution source is official FIFA information.",
      endDate: "2026-07-20T00:00:00Z",
      createdAt: "2025-01-01T00:00:00Z",
      active: true,
      closed: false,
      negRisk: true,
      enableOrderBook: true,
      liquidityNum: 8_213_436.7,
      volumeNum: 44_000_000,
      volume24hr: 1_570_807.4,
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.1265", "0.8735"]',
      clobTokenIds: '["439437288738551821447", "731296024126"]',
      bestBid: 0.126,
      bestAsk: 0.127,
      spread: 0.001,
      oneDayPriceChange: -0.005,
      oneHourPriceChange: 0.001,
    },
    {
      id: "516722",
      question: "Broken market with no tokens",
      conditionId: "0xbroken",
      slug: "broken",
      active: true,
      closed: false,
      outcomes: '["Yes", "No"]',
      outcomePrices: "not-json",
      clobTokenIds: undefined,
    },
  ],
};

describe("gamma normalization", () => {
  it("normalizes a nested event market with prices, tokens and tags", () => {
    const m = normalizeGammaMarket(eventFixture.markets[0], eventFixture);
    expect(m).not.toBeNull();
    expect(m!.conditionId).toBe("0x7976b8db");
    expect(m!.eventTitle).toBe("2026 FIFA World Cup Winner");
    expect(m!.yesTokenId).toBe("439437288738551821447");
    expect(m!.noTokenId).toBe("731296024126");
    expect(m!.yesPrice).toBeCloseTo(0.1265, 6);
    expect(m!.noPrice).toBeCloseTo(0.8735, 6);
    expect(m!.spread).toBeCloseTo(0.001, 6);
    expect(m!.midpoint).toBeCloseTo(0.1265, 4);
    expect(m!.liquidity).toBeCloseTo(8_213_436.7, 1);
    expect(m!.negRisk).toBe(true);
    expect(m!.tags).toContain("Sports");
    expect(m!.source).toBe("gamma");
  });

  it("skips meta tags when picking a category", () => {
    expect(pickCategory(eventFixture.tags)).toBe("Sports");
    expect(pickCategory([])).toBe("Uncategorized");
  });

  it("tolerates malformed JSON-encoded fields", () => {
    const m = normalizeGammaMarket(eventFixture.markets[1], eventFixture);
    expect(m).not.toBeNull();
    expect(m!.outcomes.every((o) => o.tokenId === "")).toBe(true);
    expect(m!.yesPrice).toBeUndefined();
  });
});

describe("gamma fetch", () => {
  it("fetches, flattens and filters active tokenized markets", async () => {
    const fetchFn = stubFetch([
      { match: (u) => u.includes("/events"), body: [eventFixture] },
    ]);
    const markets = await fetchActiveMarkets({ limit: 10 }, { fetchFn });
    // the broken market (no clobTokenIds) must be filtered out
    expect(markets).toHaveLength(1);
    expect(markets[0].question).toContain("Spain");
  });

  it("passes filter params through the query string", async () => {
    let seenUrl = "";
    const fetchFn = stubFetch([
      {
        match: (u) => {
          seenUrl = u;
          return true;
        },
        body: [],
      },
    ]);
    await fetchActiveMarkets({ limit: 42, tagSlug: "sports" }, { fetchFn });
    expect(seenUrl).toContain("limit=42");
    expect(seenUrl).toContain("tag_slug=sports");
    expect(seenUrl).toContain("active=true");
    expect(seenUrl).toContain("closed=false");
  });

  it("raises a typed error with HTTP status on failure", async () => {
    const fetchFn = stubFetch([
      { match: () => true, body: { error: "rate limited" }, status: 429 },
    ]);
    await expect(fetchActiveMarkets({}, { fetchFn })).rejects.toThrowError(
      PolymarketApiError,
    );
    await expect(fetchActiveMarkets({}, { fetchFn })).rejects.toMatchObject({
      status: 429,
    });
  });
});
