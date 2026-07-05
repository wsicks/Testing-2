import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/server/store";
import { ensureBackgroundScanner } from "@/server/scanner";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureBackgroundScanner();
  const sp = req.nextUrl.searchParams;
  const store = await getStore();
  const signals = await store.listSignals({
    strategy: sp.get("strategy") ?? undefined,
    status: sp.get("status") ?? undefined,
    conditionId: sp.get("conditionId") ?? undefined,
    // NaN-safe: ?limit=abc must not become slice(0, NaN) / prisma take:NaN
    limit: Math.min(1_000, Math.max(1, Math.floor(Number(sp.get("limit")) || 100))),
  });
  return NextResponse.json({ signals });
}
