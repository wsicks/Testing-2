import { NextResponse } from "next/server";
import { audit } from "@/server/audit";
import { scanOnce } from "@/server/scanner";

export const dynamic = "force-dynamic";

export async function POST() {
  // when the dedicated worker owns scheduling, a manual scan in the web
  // process would run settlement + the autopilot exit sweep CONCURRENTLY
  // with the worker's tick — the mutexes are in-process only, so the two
  // processes would double-apply fills and clobber the managed-lot list
  if (process.env.DISABLE_EMBEDDED_SCANNER === "true") {
    return NextResponse.json(
      { error: "scanning is owned by the dedicated worker process in this deployment" },
      { status: 409 },
    );
  }
  await audit("user", "scan_requested", "Manual scan requested", {
    feedType: "user_action",
  });
  const summary = await scanOnce(true);
  return NextResponse.json(summary);
}
