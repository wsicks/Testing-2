// Audit trail: every signal, approval, order event, cancel, fill and error is
// recorded via this module. Audit writes also fan out to the live feed.

import type {
  AuditActor,
  AuditSeverity,
  FeedEventType,
} from "@/lib/types";
import { genId } from "@/lib/utils";
import { publishFeed } from "./events";
import { getStore } from "./store";

export async function audit(
  actor: AuditActor,
  type: string,
  message: string,
  opts: {
    severity?: AuditSeverity;
    data?: Record<string, unknown>;
    feedType?: FeedEventType;
  } = {},
): Promise<void> {
  const evt = {
    id: genId("aud"),
    ts: Date.now(),
    actor,
    type,
    severity: opts.severity ?? "info",
    message,
    data: opts.data,
  };
  try {
    const store = await getStore();
    await store.addAudit(evt);
  } catch (err) {
    console.error("[polyquant] audit write failed:", err);
  }
  if (opts.feedType) {
    publishFeed(opts.feedType, message, {
      severity: opts.severity,
      data: opts.data,
    });
  }
}
