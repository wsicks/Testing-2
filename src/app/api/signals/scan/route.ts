import { NextResponse } from "next/server";
import { audit } from "@/server/audit";
import { scanOnce } from "@/server/scanner";

export const dynamic = "force-dynamic";

export async function POST() {
  await audit("user", "scan_requested", "Manual scan requested", {
    feedType: "user_action",
  });
  const summary = await scanOnce(true);
  return NextResponse.json(summary);
}
