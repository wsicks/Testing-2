import { NextResponse } from "next/server";
import { getAutopilotStatus } from "@/server/autopilot";
import { ensureBackgroundScanner } from "@/server/scanner";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureBackgroundScanner();
  const status = await getAutopilotStatus();
  return NextResponse.json(status);
}
