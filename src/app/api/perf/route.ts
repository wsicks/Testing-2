import { NextResponse } from "next/server";
import { auditQueueDepth } from "@/server/audit";
import { regInfo } from "@/server/hotpath/registry";
import { perfSnapshot } from "@/server/perf";

export const dynamic = "force-dynamic";

export async function GET() {
  const snap = perfSnapshot();
  return NextResponse.json({
    ...snap,
    auditQueueDepth: auditQueueDepth(),
    registry: regInfo(),
    budgetsMs: {
      note: "hot.* metrics are internal processing on in-memory data (target <20ms p95). upstream.* metrics time EXTERNAL Polymarket APIs and carry no latency promise.",
      hotP95Target: 20,
    },
  });
}
