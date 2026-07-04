// Server-Sent Events stream for the live feed panel.

import { NextRequest } from "next/server";
import { recentFeed, subscribeFeed } from "@/server/events";
import { ensureBackgroundScanner } from "@/server/scanner";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureBackgroundScanner();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      for (const evt of recentFeed(40)) send(evt);
      const unsub = subscribeFeed(send);
      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);
      req.signal.addEventListener("abort", () => {
        closed = true;
        unsub();
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
