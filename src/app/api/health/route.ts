import { NextResponse } from "next/server";
import { CLOB_API_URL, GAMMA_API_URL } from "@/lib/constants";
import { cached } from "@/server/cache";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

async function ping(url: string): Promise<{ ok: boolean; latencyMs?: number }> {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok, latencyMs: Date.now() - t0 };
  } catch {
    return { ok: false };
  }
}

export async function GET() {
  const health = await cached("health", 10_000, async () => {
    const [gamma, clob] = await Promise.all([
      ping(`${GAMMA_API_URL}/events?limit=1`),
      ping(`${CLOB_API_URL}/ok`),
    ]);
    return { gamma, clob, checkedAt: Date.now() };
  });
  const store = await getStore();
  const settings = await store.getSettings();
  const openOrders = await store.listOrders(undefined, [
    "open",
    "partially_filled",
    "created",
  ]);
  return NextResponse.json({
    ok: health.gamma.ok || health.clob.ok,
    ...health,
    serverTime: Date.now(),
    killSwitch: settings.killSwitch,
    scannersEnabled: settings.scannersEnabled,
    liveTradingEnv: process.env.LIVE_TRADING_ENABLED === "true",
    openOrdersCount: openOrders.length,
  });
}
