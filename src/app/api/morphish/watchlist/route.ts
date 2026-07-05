import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/server/store";

export const dynamic = "force-dynamic";

const schema = z.object({
  conditionId: z.string().min(4),
  add: z.boolean(),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const store = await getStore();
  const settings = await store.getSettings();
  const set = new Set(settings.watchlist);
  if (parsed.data.add) set.add(parsed.data.conditionId);
  else set.delete(parsed.data.conditionId);
  const updated = await store.patchSettings({ watchlist: [...set] });
  return NextResponse.json({ watchlist: updated.watchlist });
}
