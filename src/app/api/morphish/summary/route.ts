import { NextRequest, NextResponse } from "next/server";
import { ensureBackgroundScanner } from "@/server/scanner";
import { getStore } from "@/server/store";
import { morphishSummary, type MorphishSummary } from "@/server/morphish";
import type { TerminalMode } from "@/lib/types";

export const dynamic = "force-dynamic";

// 5s in-memory memo per mode: dashboard polls hit RAM, the (store-touching)
// recompute runs at most once per window
interface MemoGlobal {
  memo: Map<string, { at: number; payload: MorphishSummary }>;
}
const g = globalThis as unknown as { __eqMorphishSummary?: MemoGlobal };
const memo = () => (g.__eqMorphishSummary ??= { memo: new Map() }).memo;

export async function GET(req: NextRequest) {
  ensureBackgroundScanner();
  const store = await getStore();
  const settings = await store.getSettings();
  // validate mode: an arbitrary ?mode= string would insert a permanent memo
  // entry (unbounded map growth) and recompute the store for junk values
  const rawMode = req.nextUrl.searchParams.get("mode");
  const mode: TerminalMode =
    rawMode === "demo" || rawMode === "paper" || rawMode === "live"
      ? rawMode
      : settings.defaultMode;
  const cached = memo().get(mode);
  if (cached && Date.now() - cached.at < 5_000) {
    return NextResponse.json({ ...cached.payload, cached: true });
  }
  // live mode counts LIVE intents; paper/demo count their own paper book.
  // Passing undefined would sum paper+demo rows onto a live board.
  let openOrderExposure = 0;
  if (mode === "live") {
    const intents = await store.listIntents(["submitted", "open", "partially_filled"]);
    openOrderExposure = intents.reduce((a, o) => a + (o.size - o.filledSize) * o.price, 0);
  } else {
    const orders = await store.listOrders(mode, ["open", "partially_filled"]);
    openOrderExposure = orders.reduce((a, o) => a + (o.size - o.filledSize) * o.price, 0);
  }
  // 7d change from real portfolio snapshots — absent (never faked) until a
  // week of history exists; anchored to the oldest snapshot ≤7d back that is
  // at least 1d old
  let change7dUsd: number | undefined;
  let change7dSpanDays: number | undefined;
  try {
    const snaps = await store.listPortfolioSnapshots(mode, 400);
    const nowMs = Date.now();
    const anchor = [...snaps]
      .filter((x) => nowMs - x.ts >= 86_400_000 && nowMs - x.ts <= 7 * 86_400_000)
      .sort((a, b) => a.ts - b.ts)[0];
    if (anchor) {
      const current = snaps.sort((a, b) => b.ts - a.ts)[0];
      if (current) {
        change7dUsd = Number((current.totalValue - anchor.totalValue).toFixed(2));
        // honest label: with <7d of history this is an Nd change, not 7d
        change7dSpanDays = Math.max(1, Math.round((nowMs - anchor.ts) / 86_400_000));
      }
    }
  } catch {
    /* snapshots unavailable → pill shows — */
  }
  const payload = await morphishSummary(mode, {
    killSwitch: settings.killSwitch,
    openOrderExposure,
    change7dUsd,
    change7dSpanDays,
  });
  memo().set(mode, { at: Date.now(), payload });
  return NextResponse.json(payload);
}
