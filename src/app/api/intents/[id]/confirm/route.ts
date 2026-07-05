import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { confirmLiveIntent } from "@/server/execution";

export const dynamic = "force-dynamic";

// live-money mutating route: the body is validated, never duck-typed
const Body = z.object({ confirmationText: z.string().max(60).optional() });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  try {
    const intent = await confirmLiveIntent(id, parsed.data.confirmationText);
    return NextResponse.json({ intent });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "confirm failed" },
      { status: 400 },
    );
  }
}
