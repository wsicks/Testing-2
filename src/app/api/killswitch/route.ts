import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { setKillSwitch } from "@/server/execution";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

// a safety control must never infer intent: `engaged` is required, and a
// missing/malformed body is a 400 — it must NEVER default to "disengage"
const Body = z.object({ engaged: z.boolean() });

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "body must be {engaged: boolean} — refusing to guess on a safety control" },
      { status: 400 },
    );
  }
  await setKillSwitch(parsed.data.engaged);
  const store = await getStore();
  const settings = await store.getSettings();
  return NextResponse.json({ killSwitch: settings.killSwitch });
}
