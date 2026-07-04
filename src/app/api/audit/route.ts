import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const store = await getStore();
  const events = await store.listAudit({
    type: sp.get("type") ?? undefined,
    actor: sp.get("actor") ?? undefined,
    severity: sp.get("severity") ?? undefined,
    q: sp.get("q") ?? undefined,
    limit: Number(sp.get("limit") ?? 200),
  });
  return NextResponse.json({ events });
}
