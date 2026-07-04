"use client";

import Link from "next/link";
import {
  useCancelAll,
  useCancelIntent,
  useCancelOrder,
  useIntents,
  useOrders,
} from "@/hooks/api";
import { useTerminal } from "@/store/terminal";
import { fmtCents, fmtDateTime } from "@/lib/format";
import type { OrderStatus, LiveIntentStatus } from "@/lib/types";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Num } from "@/components/ui/num";
import { EmptyNote } from "@/components/ui/spinner";

const STATUS_TONE: Partial<Record<LiveIntentStatus | OrderStatus, "pos" | "neg" | "warn" | "accent">> = {
  filled: "pos",
  partially_filled: "accent",
  open: "accent",
  submitted: "accent",
  created: "accent",
  approval_required: "warn",
  previewed: "warn",
  confirmed: "warn",
  canceled: "warn",
  rejected: "neg",
  expired: "warn",
};

export default function OrdersPage() {
  const mode = useTerminal((s) => s.mode);
  const { data: ordersData } = useOrders(mode === "live" ? undefined : mode);
  const { data: intentsData } = useIntents();
  const cancelOrder = useCancelOrder();
  const cancelAll = useCancelAll();
  const cancelIntent = useCancelIntent();

  const orders = ordersData?.orders ?? [];
  const intents = intentsData?.intents ?? [];
  const cancellable = ["created", "open", "partially_filled"];

  return (
    <div className="space-y-2">
      <Panel
        title={`orders — ${mode === "live" ? "paper/demo history" : mode} (${orders.length})`}
        right={
          <Button
            size="xs"
            variant="danger"
            disabled={
              cancelAll.isPending ||
              !orders.some((o) => cancellable.includes(o.status))
            }
            onClick={() => cancelAll.mutate(mode === "demo" ? "demo" : "paper")}
          >
            cancel all
          </Button>
        }
        bodyClassName="p-0"
      >
        {orders.length === 0 ? (
          <EmptyNote>no orders yet — place one from a market's order ticket</EmptyNote>
        ) : (
          <table className="w-full text-2xs">
            <thead>
              <tr className="border-b border-line-strong text-left">
                {["created", "mode", "market", "side", "type", "price", "size", "filled", "avg fill", "status", ""].map((h) => (
                  <th key={h} className="cell label">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-line/60 hover:bg-paper">
                  <td className="cell"><Num className="text-ink-faint">{fmtDateTime(o.createdAt)}</Num></td>
                  <td className="cell"><Badge variant={o.mode === "demo" ? "warn" : "accent"}>{o.mode}</Badge></td>
                  <td className="max-w-60 truncate px-2 py-1">
                    {o.conditionId ? (
                      <Link href={`/market/${o.conditionId}`} className="hover:underline">
                        {o.marketTitle ?? o.tokenId.slice(0, 14)}
                      </Link>
                    ) : (
                      o.marketTitle ?? o.tokenId.slice(0, 14)
                    )}
                    <span className="ml-1 text-ink-faint">{o.outcome}</span>
                  </td>
                  <td className="cell"><Num tone={o.side === "BUY" ? "pos" : "neg"}>{o.side}</Num></td>
                  <td className="cell">{o.orderType}</td>
                  <td className="cell"><Num>{fmtCents(o.price)}</Num></td>
                  <td className="cell"><Num>{o.size}</Num></td>
                  <td className="cell"><Num>{o.filledSize}</Num></td>
                  <td className="cell"><Num>{o.avgFillPrice ? fmtCents(o.avgFillPrice) : "—"}</Num></td>
                  <td className="cell">
                    <Badge variant={STATUS_TONE[o.status] ?? "default"}>{o.status}</Badge>
                  </td>
                  <td className="cell">
                    {cancellable.includes(o.status) ? (
                      <Button size="xs" onClick={() => cancelOrder.mutate(o.id)}>
                        cancel
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={`live order intents (${intents.length})`} bodyClassName="p-0">
        {intents.length === 0 ? (
          <EmptyNote>
            no live order intents — live trading stays locked until explicitly
            enabled, and every intent requires manual confirmation
          </EmptyNote>
        ) : (
          <table className="w-full text-2xs">
            <thead>
              <tr className="border-b border-line-strong text-left">
                {["created", "market", "side", "price", "size", "status", "clob id / error", ""].map((h) => (
                  <th key={h} className="cell label">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {intents.map((i) => (
                <tr key={i.id} className="border-b border-line/60">
                  <td className="cell"><Num className="text-ink-faint">{fmtDateTime(i.createdAt)}</Num></td>
                  <td className="max-w-60 truncate px-2 py-1">
                    {i.marketTitle ?? i.tokenId.slice(0, 14)}{" "}
                    <span className="text-ink-faint">{i.outcome}</span>
                  </td>
                  <td className="cell"><Num tone={i.side === "BUY" ? "pos" : "neg"}>{i.side}</Num></td>
                  <td className="cell"><Num>{fmtCents(i.price)}</Num></td>
                  <td className="cell"><Num>{i.size}</Num></td>
                  <td className="cell">
                    <Badge variant={STATUS_TONE[i.status] ?? "default"}>{i.status}</Badge>
                  </td>
                  <td className="max-w-52 truncate px-2 py-1 text-ink-faint" title={i.error}>
                    {i.clobOrderId ?? i.error ?? "—"}
                  </td>
                  <td className="cell">
                    {!["filled", "canceled", "rejected", "expired"].includes(i.status) ? (
                      <Button size="xs" onClick={() => cancelIntent.mutate(i.id)}>
                        cancel
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
