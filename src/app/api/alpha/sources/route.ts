import { NextRequest, NextResponse } from "next/server";
import { ensureBackgroundScanner } from "@/server/scanner";
import { ensureSeeded, runSourceHealthChecks } from "@/server/alpha/foundry";
import { listSources } from "@/server/alpha/repo";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureBackgroundScanner();
  await ensureSeeded();
  return NextResponse.json({ sources: await listSources() });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "health") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  await ensureSeeded();
  const checked = await runSourceHealthChecks();
  return NextResponse.json({ checked, sources: await listSources() });
}
