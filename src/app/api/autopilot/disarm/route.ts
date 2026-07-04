import { NextResponse } from "next/server";
import { disarmAutopilot, resetAutopilotSession } from "@/server/autopilot";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (body?.resetSession) {
    await resetAutopilotSession();
    return NextResponse.json({ ok: true, reset: true });
  }
  await disarmAutopilot("user requested disarm", "user");
  return NextResponse.json({ ok: true });
}
