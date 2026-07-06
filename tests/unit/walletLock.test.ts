import { beforeEach, describe, expect, it } from "vitest";
import { withWalletsLock } from "@/server/alpha/repo";
import { MemoryStore } from "@/server/store/memory";
import type { PaperOrder } from "@/lib/types";

beforeEach(() => {
  (globalThis as Record<string, unknown>).__eqWalletsLock = undefined;
});

describe("wallets write lock", () => {
  it("serializes overlapping read-modify-write sections", async () => {
    const events: string[] = [];
    const slow = withWalletsLock(async () => {
      events.push("slow:start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("slow:end");
    });
    const fast = withWalletsLock(async () => {
      events.push("fast:start");
      events.push("fast:end");
    });
    await Promise.all([slow, fast]);
    // fast must not begin until slow's whole section finished
    expect(events).toEqual(["slow:start", "slow:end", "fast:start", "fast:end"]);
  });

  it("a throwing section releases the lock for the next caller", async () => {
    await expect(
      withWalletsLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const ok = await withWalletsLock(async () => "ran");
    expect(ok).toBe("ran");
  });
});

describe("memory store order/intent caps", () => {
  function order(i: number, status: PaperOrder["status"]): PaperOrder {
    const now = Date.now();
    return {
      id: `o${i}`,
      mode: "paper",
      tokenId: "tok",
      side: "BUY",
      orderType: "limit",
      price: 0.5,
      size: 1,
      filledSize: 0,
      status,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("evicts only TERMINAL orders past the cap — open orders survive", async () => {
    const store = new MemoryStore(null);
    // 10 open orders first (oldest), then flood with terminal ones
    for (let i = 0; i < 10; i++) await store.createOrder(order(i, "open"));
    for (let i = 10; i < 3_100; i++) await store.createOrder(order(i, "filled"));
    const open = await store.listOrders("paper", ["open"]);
    expect(open).toHaveLength(10); // never evicted despite being oldest
    const all = await store.listOrders("paper");
    expect(all.length).toBeLessThanOrEqual(3_000);
  });
});
