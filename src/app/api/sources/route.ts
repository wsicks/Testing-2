import { NextResponse } from "next/server";
import { allSourceStatuses } from "@/lib/venues/registry";
import { getReferencePrices } from "@/server/crossVenue";
import { ensureBackgroundScanner } from "@/server/scanner";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureBackgroundScanner();
  const [sources, referencePrices] = await Promise.all([
    Promise.resolve(allSourceStatuses()),
    getReferencePrices(),
  ]);
  return NextResponse.json({ sources, referencePrices });
}
