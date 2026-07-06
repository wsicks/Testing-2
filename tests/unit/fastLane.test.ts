import { describe, expect, it } from "vitest";
import { fetchMidpoints } from "@/lib/polymarket/clob";
import { categoryHalfLives } from "@/lib/alpha/evidenceLab";
import type { AlphaOutcome } from "@/lib/alpha/types";
import { stubFetch } from "../helpers";

const now = Date.now();

describe("batch midpoints adapter", () => {
  it("parses the verified token→string map and drops junk values", async () => {
    const fetchFn = stubFetch([
      {
        match: (u) => u.endsWith("/midpoints"),
        body: { tokA: "0.9535", tokB: "0.0465", tokC: "not-a-number", tokD: "0" },
      },
    ]);
    const mids = await fetchMidpoints(["tokA", "tokB", "tokC", "tokD"], { fetchFn });
    expect(mids.get("tokA")).toBeCloseTo(0.9535, 4);
    expect(mids.get("tokB")).toBeCloseTo(0.0465, 4);
    expect(mids.has("tokC")).toBe(false); // NaN dropped, never served
    expect(mids.has("tokD")).toBe(false); // 0 is outside (0,1) — dropped
  });

  it("empty input never hits the network", async () => {
    const fetchFn = stubFetch([]); // any request would 404 → throw
    expect((await fetchMidpoints([], { fetchFn })).size).toBe(0);
  });
});

describe("narrative half-life", () => {
  function row(category: string, d5m: number, d1h: number, d24h: number): AlphaOutcome {
    return {
      id: `${category}:${Math.random()}`,
      featureId: "f",
      signalId: "s",
      conditionId: "m",
      direction: "BUY_YES",
      entryMid: 0.5,
      tradable: true,
      wasProposed: true,
      category,
      createdAt: now,
      buckets: {
        b5m: { drift: d5m, at: now },
        b1h: { drift: d1h, at: now },
        b24h: { drift: d24h, at: now },
      },
    };
  }

  it("classifies fast and slow categories from realized-move shares", () => {
    const rows: AlphaOutcome[] = [];
    // sports: 80% of the 24h move done at 5m — repricing in minutes
    for (let i = 0; i < 20; i++) rows.push(row("sports", 0.04, 0.045, 0.05));
    // courts: 10% at 5m, 20% at 1h — day+ repricing
    for (let i = 0; i < 20; i++) rows.push(row("courts", 0.005, 0.01, 0.05));
    const hl = categoryHalfLives(rows);
    const sports = hl.find((h) => h.category === "sports")!;
    const courts = hl.find((h) => h.category === "courts")!;
    expect(sports.speed).toBe("minutes");
    expect(sports.share5m).toBeCloseTo(0.8, 2);
    expect(courts.speed).toBe("day+");
    expect(courts.share1h).toBeCloseTo(0.2, 2);
  });

  it("gates on sample size and real moves; overshoot ratios cap at 1.5", () => {
    const rows: AlphaOutcome[] = [];
    for (let i = 0; i < 10; i++) rows.push(row("thin", 0.02, 0.03, 0.05)); // n<15
    for (let i = 0; i < 20; i++) rows.push(row("noise", 0.001, 0.002, 0.004)); // |24h|<1c
    for (let i = 0; i < 20; i++) rows.push(row("overshoot", 0.02, 0.09, 0.02)); // 1h >> 24h
    const hl = categoryHalfLives(rows);
    expect(hl.find((h) => h.category === "thin")).toBeUndefined();
    expect(hl.find((h) => h.category === "noise")).toBeUndefined();
    expect(hl.find((h) => h.category === "overshoot")!.share1h).toBeLessThanOrEqual(1.5);
  });
});
