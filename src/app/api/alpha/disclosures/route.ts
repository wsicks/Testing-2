import { NextRequest, NextResponse } from "next/server";
import { ensureBackgroundScanner } from "@/server/scanner";
import { listDisclosures, refreshDisclosures } from "@/server/alpha/disclosures";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureBackgroundScanner();
  const rows = await listDisclosures();
  return NextResponse.json({
    disclosures: [...rows].sort((a, b) => b.fetchedAt - a.fetchedAt).slice(0, 120),
  });
}

export async function POST(_req: NextRequest) {
  const added = await refreshDisclosures();
  const rows = await listDisclosures();
  return NextResponse.json({
    added,
    disclosures: [...rows].sort((a, b) => b.fetchedAt - a.fetchedAt).slice(0, 120),
  });
}
