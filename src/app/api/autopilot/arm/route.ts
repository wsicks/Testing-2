import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { armLiveAutopilot } from "@/server/autopilot";

export const dynamic = "force-dynamic";

const schema = z.object({
  confirmation: z.string(),
  ttlMinutes: z.number().min(5).max(480).default(60),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid arm request" }, { status: 400 });
  }
  const result = await armLiveAutopilot(
    parsed.data.confirmation,
    parsed.data.ttlMinutes,
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
