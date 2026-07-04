import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/server/audit";
import { invalidateExposure } from "@/server/hotpath/exposure";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const mode = body?.mode;
  if (mode !== "paper" && mode !== "demo") {
    return NextResponse.json({ error: "mode must be paper or demo" }, { status: 400 });
  }
  const store = await getStore();
  await store.resetMode(mode);
  invalidateExposure(mode);
  await audit("user", "account_reset", `${mode} account reset to starting cash`, {
    severity: "warn",
    feedType: "user_action",
  });
  return NextResponse.json({ ok: true });
}
