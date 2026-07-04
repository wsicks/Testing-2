import { NextResponse } from "next/server";
import { cancelOrder } from "@/server/execution";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const order = await cancelOrder(id, "user");
  if (!order) return NextResponse.json({ error: "order not found" }, { status: 404 });
  return NextResponse.json({ order });
}
