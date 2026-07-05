import { NextResponse } from "next/server";
import { ensureBackgroundScanner } from "@/server/scanner";
import { morphishGraph } from "@/server/morphish";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureBackgroundScanner();
  return NextResponse.json(await morphishGraph());
}
