import { NextRequest, NextResponse } from "next/server";
import { confirmLiveIntent } from "@/server/execution";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    const intent = await confirmLiveIntent(id, body?.confirmationText);
    return NextResponse.json({ intent });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "confirm failed" },
      { status: 400 },
    );
  }
}
