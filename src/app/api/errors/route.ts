// Runtime error log API. GET lists deduped error entries (open first);
// POST resolves an entry or records a client-side error so browser console
// failures land in the same triage queue as server ones.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listErrors, logError, resolveError, errorLogStats } from "@/server/errorLog";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [errors, stats] = await Promise.all([listErrors(), errorLogStats()]);
  return NextResponse.json({ errors, ...stats });
}

const PostBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resolve"), id: z.string().min(1) }),
  z.object({
    action: z.literal("log"),
    source: z.string().min(1).max(80),
    message: z.string().min(1).max(300),
    detail: z.string().max(300).optional(),
  }),
]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const body = parsed.data;
  if (body.action === "resolve") {
    const ok = await resolveError(body.id);
    return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
  }
  // client-reported errors are always namespaced so they can never
  // impersonate a server source
  logError(`client:${body.source}`, body.message, body.detail);
  return NextResponse.json({ ok: true });
}
