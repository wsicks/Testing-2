import { NextResponse } from "next/server";
import { cancelIntent } from "@/server/execution";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const intent = await cancelIntent(id);
  if (!intent) return NextResponse.json({ error: "intent not found" }, { status: 404 });
  return NextResponse.json({ intent });
}
