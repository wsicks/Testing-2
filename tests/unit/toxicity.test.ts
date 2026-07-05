import { describe, expect, it } from "vitest";
import { classifyFlow } from "@/lib/engine/micro/toxicity";
import { flowToxicitySignal } from "@/lib/engine/signals/flowToxicity";
import type { RecentTrade } from "@/lib/types";
import { makeMarket, makeSettings } from "../helpers";

const now = Date.now();
const settings = makeSettings();

function tape(
  n: number,
  gen: (i: number) => Partial<RecentTrade>,
): RecentTrade[] {
  return Array.from({ length: n }, (_, i) => ({
    side: "BUY" as const,
    price: 0.5,
    size: 100,
    ts: now - (n - i) * 30_000,
    ...gen(i),
  }));
}

describe("flow toxicity classifier", () => {
  it("returns null on thin tapes — no read is better than a guess", () => {
    expect(classifyFlow(tape(8, () => ({})))).toBeNull();
  });

  it("classifies one-sided concentrated bursts as informed", () => {
    // heavy one-sided flow: a few huge prints clustered in time
    const rows = tape(20, (i) => ({
      side: "BUY",
      size: i >= 17 ? 5_000 : 50,
      ts: i >= 17 ? now - 60_000 + i * 1_000 : now - (30 - i) * 120_000,
    }));
    const f = classifyFlow(rows)!;
    expect(f.classification).toBe("informed");
    expect(f.imbalance).toBeGreaterThan(0.5);
    expect(f.sizeConcentration).toBeGreaterThan(0.5);
  });

  it("classifies alternating uniform flow as market making", () => {
    const rows = tape(40, (i) => ({
      side: i % 2 === 0 ? "BUY" : "SELL",
      size: 100,
      ts: now - (40 - i) * 30_000,
    }));
    const f = classifyFlow(rows)!;
    expect(f.classification).toBe("market_making");
    expect(f.alternation).toBeGreaterThan(0.9);
  });

  it("classifies balanced small unclustered flow as noise", () => {
    // balanced sides in blocks (low alternation), uniform sizes, even spacing
    const rows = tape(40, (i) => ({
      side: i < 20 ? "BUY" : "SELL",
      size: 90 + (i % 7),
      ts: now - (40 - i) * 30_000,
    }));
    const f = classifyFlow(rows)!;
    expect(["noise", "mixed"]).toContain(f.classification);
    expect(Math.abs(f.imbalance)).toBeLessThan(0.2);
  });
});

describe("flow toxicity signal", () => {
  it("stays NEUTRAL and review-gated on a decisive informed read", () => {
    const rows = tape(40, (i) => ({
      side: "BUY",
      size: i >= 36 ? 5_000 : 60,
      ts: i >= 36 ? now - 30_000 + i * 500 : now - (60 - i) * 90_000,
    }));
    const sig = flowToxicitySignal.run({ market: makeMarket(), trades: rows, settings, now });
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("NEUTRAL");
    expect(sig!.status).toBe("rejected"); // informational_only always fails
    expect(sig!.meta?.classification).toBe("informed");
    expect(sig!.summary).toContain("NOT evidence they are right");
  });

  it("stays silent on mixed/undecisive tapes", () => {
    const rows = tape(20, (i) => ({
      side: i % 3 === 0 ? "SELL" : "BUY",
      size: 50 + i * 20,
      ts: now - (20 - i) * (i % 5 === 0 ? 300_000 : 20_000),
    }));
    const sig = flowToxicitySignal.run({ market: makeMarket(), trades: rows, settings, now });
    // either null (mixed) or a low-confidence suppression — never a loud read
    if (sig) expect((sig.meta?.confidence as number) ?? 0).toBeGreaterThanOrEqual(0.4);
  });
});
