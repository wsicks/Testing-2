import { NextRequest, NextResponse } from "next/server";
import { cancelAllOrders } from "@/server/execution";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const mode = body?.mode === "demo" ? "demo" : "paper";
  const count = await cancelAllOrders(mode);
  return NextResponse.json({ canceled: count });
}
