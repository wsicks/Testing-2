import { NextRequest, NextResponse } from "next/server";
import { setKillSwitch } from "@/server/execution";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const engaged = Boolean(body?.engaged);
  await setKillSwitch(engaged);
  const store = await getStore();
  const settings = await store.getSettings();
  return NextResponse.json({ killSwitch: settings.killSwitch });
}
