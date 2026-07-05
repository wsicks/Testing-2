import { NextRequest, NextResponse } from "next/server";
import { ensureBackgroundScanner } from "@/server/scanner";
import { morphishRidge } from "@/server/morphish";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureBackgroundScanner();
  const selected = req.nextUrl.searchParams.get("selected") ?? undefined;
  return NextResponse.json(await morphishRidge(selected));
}
