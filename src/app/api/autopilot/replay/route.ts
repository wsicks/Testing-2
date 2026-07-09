import { NextResponse } from "next/server";
import { getAutopilotReplay } from "@/server/autopilot";
import { ensureBackgroundScanner } from "@/server/scanner";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureBackgroundScanner();
  return NextResponse.json(await getAutopilotReplay());
}
