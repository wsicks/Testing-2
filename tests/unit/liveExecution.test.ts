import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveOrderIntent, LiveOrderSnapshot, NormalizedMarket, OrderBookData } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/constants";
import { makeBook, makeMarket } from "../helpers";

const fixtures: { market: NormalizedMarket; book: OrderBookData } = {
  market: makeMarket(),
  book: makeBook(),
};

const live = {
  submit: vi.fn<(intent: LiveOrderIntent) => Promise<LiveOrderSnapshot>>(),
  snapshot: vi.fn<(intent: LiveOrderIntent) => Promise<LiveOrderSnapshot>>(),
};

const OLD_LIVE_FLAG = process.env.LIVE_TRADING_ENABLED;

vi.mock("@/server/marketData", () => ({
  getMarketByCondition: async (id: string) =>
    id === fixtures.market.conditionId ? fixtures.market : undefined,
  getMarketByToken: async (tokenId: string) =>
    tokenId === fixtures.market.yesTokenId ? fixtures.market : undefined,
  getBook: async () => fixtures.book,
}));

vi.mock("@/server/liveAdapter", () => ({
  submitLiveOrder: (intent: LiveOrderIntent) => live.submit(intent),
  fetchLiveOrderSnapshot: (intent: LiveOrderIntent) => live.snapshot(intent),
  cancelLiveOrder: vi.fn(),
}));

import {
  confirmLiveIntent,
  createLiveIntent,
  reconcileLiveIntent,
} from "@/server/execution";
import { getStore } from "@/server/store";

const base = {
  mode: "live" as const,
  conditionId: "0xcond1",
  tokenId: "tok-yes",
  outcome: "Yes",
  side: "BUY" as const,
  orderType: "limit" as const,
  price: 0.56,
  size: 10,
  winProbability: 0.65,
};

async function enableLive() {
  const store = await getStore();
  await store.resetMode("live");
  await store.patchSettings({
    liveModeEnabled: true,
    termsAcceptedAt: Date.now(),
    liveDeclaredCashUsd: 10_000,
    venues: {
      ...DEFAULT_SETTINGS.venues,
      polymarket: {
        ...DEFAULT_SETTINGS.venues.polymarket,
        liveEnabled: true,
      },
    },
  });
}

describe("live order reconciliation", () => {
  beforeEach(async () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    fixtures.market = makeMarket();
    fixtures.book = makeBook();
    live.submit.mockReset();
    live.snapshot.mockReset();
    await enableLive();
  });

  afterEach(() => {
    if (OLD_LIVE_FLAG === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = OLD_LIVE_FLAG;
  });

  it("keeps accepted-but-unfilled GTC orders open instead of marking them filled", async () => {
    live.submit.mockResolvedValue({ orderId: "clob-open", status: "open", filledSize: 0 });
    live.snapshot.mockResolvedValue({ orderId: "clob-open", status: "open", filledSize: 0 });

    const { intent } = await createLiveIntent(base);
    const confirmed = await confirmLiveIntent(intent.id, undefined);

    expect(confirmed.clobOrderId).toBe("clob-open");
    expect(confirmed.status).toBe("open");
    expect(confirmed.filledSize).toBe(0);
  });

  it("records partial fills only when venue reconciliation reports matched size", async () => {
    live.submit.mockResolvedValue({ orderId: "clob-partial", status: "open", filledSize: 0 });
    live.snapshot.mockResolvedValue({
      orderId: "clob-partial",
      status: "partially_filled",
      filledSize: 4,
    });

    const { intent } = await createLiveIntent(base);
    const confirmed = await confirmLiveIntent(intent.id, undefined);

    expect(confirmed.status).toBe("partially_filled");
    expect(confirmed.filledSize).toBe(4);
  });

  it("can reconcile a later full fill for an existing open intent", async () => {
    live.submit.mockResolvedValue({ orderId: "clob-later", status: "open", filledSize: 0 });
    live.snapshot
      .mockResolvedValueOnce({ orderId: "clob-later", status: "open", filledSize: 0 })
      .mockResolvedValueOnce({ orderId: "clob-later", status: "filled", filledSize: 10 });

    const { intent } = await createLiveIntent(base);
    const confirmed = await confirmLiveIntent(intent.id, undefined);
    expect(confirmed.status).toBe("open");

    const reconciled = await reconcileLiveIntent(intent.id);
    expect(reconciled.status).toBe("filled");
    expect(reconciled.filledSize).toBe(10);
  });
});
