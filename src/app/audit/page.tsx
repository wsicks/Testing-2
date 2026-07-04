"use client";

import { useState } from "react";
import { useAudit } from "@/hooks/api";
import { fmtDateTime } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Num } from "@/components/ui/num";
import { EmptyNote, Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const TYPES = [
  "order_preview",
  "order_submitted",
  "order_filled",
  "order_canceled",
  "order_rejected",
  "order_expired",
  "cancel_all",
  "live_intent_created",
  "live_intent_confirmed",
  "live_intent_canceled",
  "live_intent_rejected",
  "live_order_submitted",
  "live_order_error",
  "live_mode_enabled",
  "scan_complete",
  "scan_requested",
  "settings_changed",
  "kill_switch",
  "account_reset",
  "backtest_run",
  "api_error",
];

export default function AuditPage() {
  const [type, setType] = useState("");
  const [severity, setSeverity] = useState("");
  const [q, setQ] = useState("");
  const { data, isLoading } = useAudit({
    type: type || undefined,
    severity: severity || undefined,
    q: q || undefined,
  });

  return (
    <Panel
      title={`audit log (${data?.events.length ?? 0})`}
      right={
        <>
          {isLoading ? <Spinner /> : null}
          <Input
            placeholder="search…"
            className="w-40"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select className="w-40" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">all types</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
          <Select className="w-24" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">any severity</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </Select>
        </>
      }
      bodyClassName="p-0"
    >
      {data?.events.length === 0 ? (
        <EmptyNote>no audit events match</EmptyNote>
      ) : (
        <table className="w-full text-2xs">
          <thead className="sticky top-0 bg-paper">
            <tr className="border-b border-line-strong text-left">
              {["time", "actor", "type", "severity", "message"].map((h) => (
                <th key={h} className="cell label">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.events.map((e) => (
              <tr
                key={e.id}
                className={cn(
                  "border-b border-line/60 align-top",
                  e.severity === "error" && "bg-neg-soft/60",
                  e.severity === "warn" && "bg-warn-soft/40",
                )}
              >
                <td className="cell"><Num className="text-ink-faint">{fmtDateTime(e.ts)}</Num></td>
                <td className="cell">
                  <Badge
                    variant={
                      e.actor === "user"
                        ? "accent"
                        : e.actor === "risk"
                          ? "warn"
                          : e.actor === "execution"
                            ? "ink"
                            : "default"
                    }
                  >
                    {e.actor}
                  </Badge>
                </td>
                <td className="cell font-semibold">{e.type}</td>
                <td className="cell">
                  <Num tone={e.severity === "error" ? "neg" : e.severity === "warn" ? "warn" : "muted"}>
                    {e.severity}
                  </Num>
                </td>
                <td className="px-2 py-1">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
