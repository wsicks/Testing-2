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
  const mode = (req.nextUrl.searchParams.get("mode") ?? settings.defaultMode) as TerminalMode;
  const cached = memo().get(mode);
  if (cached && Date.now() - cached.at < 5_000) {
    return NextResponse.json({ ...cached.payload, cached: true });
  }
  const orders = await store.listOrders(mode === "live" ? undefined : mode, ["open", "partially_filled"]);
  const openOrderExposure = orders.reduce(
    (a, o) => a + (o.size - o.filledSize) * o.price,
    0,
  );
  const payload = await morphishSummary(mode, {
    killSwitch: settings.killSwitch,
    openOrderExposure,
  });
  memo().set(mode, { at: Date.now(), payload });
  return NextResponse.json(payload);
}
