"use client";

import { useState } from "react";
import Link from "next/link";
import { useRunScan, useSignals } from "@/hooks/api";
import { STRATEGIES } from "@/lib/engine/signals/registry";
import { fmtDateTime } from "@/lib/format";
import type { SignalResult } from "@/lib/types";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Num } from "@/components/ui/num";
import { Select } from "@/components/ui/input";
import { EmptyNote, Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

function SignalRow({ s }: { s: SignalResult }) {
  const [open, setOpen] = useState(false);
  const failed = s.checks.filter((c) => !c.passed);
  return (
    <div className="border-b border-line/60">
      <button
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-2xs hover:bg-paper"
        onClick={() => setOpen((v) => !v)}
      >
        <Num className="w-24 shrink-0 text-ink-faint">{fmtDateTime(s.createdAt)}</Num>
        <Badge variant="accent" className="w-28 shrink-0 justify-center">
          {s.strategyLabel}
        </Badge>
        <Num
          className="w-8 shrink-0 font-bold"
          tone={s.score >= 60 ? "pos" : s.score >= 40 ? "warn" : "muted"}
        >
          {s.score}
        </Num>
        <Badge
          variant={
            s.direction === "BUY_YES" ? "pos" : s.direction === "BUY_NO" ? "neg" : "default"
          }
          className="w-16 shrink-0 justify-center"
        >
          {s.direction.replace("_", " ")}
        </Badge>
        <Badge
          variant={s.status === "proposed" ? "warn" : s.status === "approved" ? "pos" : "neg"}
          className="w-16 shrink-0 justify-center"
        >
          {s.status}
        </Badge>
        <span className="min-w-0 flex-1 truncate">
          {s.conditionId ? (
            <Link
              href={`/market/${s.conditionId}`}
              className="font-semibold hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {s.marketQuestion}
            </Link>
          ) : (
            s.marketQuestion
          )}
          <span className="ml-2 text-ink-faint">{s.summary}</span>
        </span>
        <span className="shrink-0 text-ink-faint">
          {failed.length > 0 ? `${failed.length} failed` : "all passed"} {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? (
        <div className="space-y-0.5 border-t border-line/60 bg-paper px-3 py-1.5">
          {s.checks.map((c, i) => (
            <div key={i} className="flex items-start gap-2 text-2xs">
              <span
                className={cn(
                  "num w-10 shrink-0 font-bold",
                  c.passed ? "text-pos" : "text-neg",
                )}
              >
                {c.passed ? "PASS" : "FAIL"}
              </span>
              <span className="w-40 shrink-0 font-semibold">{c.name}</span>
              <span className="text-ink-soft">{c.detail}</span>
            </div>
          ))}
          <p className="pt-0.5 text-3xs text-ink-faint">
            Signals are screening outputs with full check trails — not trade
            instructions. Any order still passes the independent risk engine.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default function SignalsPage() {
  const [strategy, setStrategy] = useState("");
  const [status, setStatus] = useState("");
  const { data, isLoading } = useSignals({
    strategy: strategy || undefined,
    status: status || undefined,
    limit: 150,
  });
  const runScan = useRunScan();

  return (
    <Panel
      title={`signal engine (${data?.signals.length ?? 0})`}
      right={
        <>
          {isLoading || runScan.isPending ? <Spinner /> : null}
          <Select
            className="w-40"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
          >
            <option value="">all strategies</option>
            {STRATEGIES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
          <Select className="w-28" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">any status</option>
            <option value="proposed">proposed</option>
            <option value="rejected">rejected</option>
            <option value="approved">approved</option>
            <option value="expired">expired</option>
          </Select>
          <Button size="xs" variant="primary" onClick={() => runScan.mutate()} disabled={runScan.isPending}>
            run scan now
          </Button>
        </>
      }
      bodyClassName="p-0"
    >
      <div className="border-b border-line bg-paper px-2 py-1 text-3xs text-ink-faint">
        {STRATEGIES.map((s) => (
          <span key={s.id} className="mr-3">
            <span className="font-bold">{s.label}:</span> {s.description}
          </span>
        ))}
      </div>
      {data?.signals.length === 0 ? (
        <EmptyNote>no signals yet — run a scan or wait for the background scanner</EmptyNote>
      ) : (
        data?.signals.map((s) => <SignalRow key={s.id} s={s} />)
      )}
    </Panel>
  );
}
