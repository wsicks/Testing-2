"use client";

// Cross-venue intelligence: related markets across Polymarket/Kalshi/Coinbase
// with full rule-comparison explainability. Divergences are CANDIDATE
// discrepancies — the UI never presents them as arbitrage.

import { useState } from "react";
import Link from "next/link";
import { useCrossVenue } from "@/hooks/api";
import type { CrossVenueLink } from "@/lib/types";
import { fmtAgo } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Num } from "@/components/ui/num";
import { Select } from "@/components/ui/input";
import { EmptyNote, Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, "pos" | "warn" | "neg" | "accent" | "default"> = {
  exact: "pos",
  strong_candidate: "pos",
  weak_candidate: "warn",
  reference_only: "accent",
  conflict: "neg",
  not_comparable: "default",
};

function LinkRow({ l }: { l: CrossVenueLink }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-line/60">
      <button
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-2xs hover:bg-paper"
        onClick={() => setOpen((v) => !v)}
      >
        <Badge variant={STATUS_TONE[l.matchStatus] ?? "default"} className="w-28 shrink-0 justify-center">
          {l.matchStatus.replace("_", " ")}
        </Badge>
        <Num className="w-10 shrink-0">{(l.matchScore * 100).toFixed(0)}%</Num>
        <span className="min-w-0 flex-1 truncate">
          <Badge className="mr-1">{l.sourceVenueId}</Badge>
          <Link href={`/market/${l.sourceMarketId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
            {l.sourceTitle.slice(0, 45)}
          </Link>
          <span className="mx-1 text-ink-faint">↔</span>
          <Badge className="mr-1">{l.targetVenueId}</Badge>
          <Link href={`/market/${l.targetMarketId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
            {l.targetTitle.slice(0, 45)}
          </Link>
        </span>
        {l.divergence !== undefined ? (
          <Num tone={l.divergence > 0.05 ? "warn" : "muted"} className="shrink-0">
            Δ{(l.divergence * 100).toFixed(1)}c
          </Num>
        ) : null}
        <span className="shrink-0 text-3xs text-ink-faint">{fmtAgo(l.updatedAt)} {open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div className="space-y-0.5 border-t border-line/60 bg-paper px-3 py-1.5">
          <div className="label">rule comparison — why this status</div>
          {l.dimensions.map((d, i) => (
            <div key={i} className="grid grid-cols-[110px_1fr_1fr_2fr] gap-2 text-2xs">
              <span className={cn("num font-bold", d.comparable ? "text-pos" : "text-warn")}>
                {d.comparable ? "OK" : "REVIEW"} {d.name}
              </span>
              <span className="truncate text-ink-soft" title={d.a}>{d.a ?? "—"}</span>
              <span className="truncate text-ink-soft" title={d.b}>{d.b ?? "—"}</span>
              <span className="text-ink-faint">{d.note}</span>
            </div>
          ))}
          <p className="pt-0.5 text-3xs text-warn">
            Candidate relationship only. Resolution wording, settlement
            mechanics, fees and eligibility must be verified by a human before
            acting on any discrepancy — this is never guaranteed arbitrage.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default function CrossVenuePage() {
  const [status, setStatus] = useState("");
  const { data, isLoading } = useCrossVenue(status || undefined);
  const links = data?.links ?? [];

  return (
    <Panel
      title={`cross-venue intelligence (${links.length})`}
      right={
        <>
          {isLoading ? <Spinner /> : null}
          <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">all statuses</option>
            <option value="strong_candidate">strong candidates</option>
            <option value="weak_candidate">weak candidates</option>
            <option value="reference_only">reference links</option>
            <option value="conflict">conflicts</option>
          </Select>
        </>
      }
      bodyClassName="p-0"
    >
      <div className="border-b border-line bg-paper px-2 py-1 text-3xs text-ink-faint">
        Related markets across venues, matched by structure (parsed thresholds,
        close windows, categories, terms) — never by title similarity alone.
        Expand a row for the per-dimension rule comparison.
      </div>
      {links.length === 0 && !isLoading ? (
        <EmptyNote>no cross-venue relationships detected in the current universe</EmptyNote>
      ) : (
        links.map((l) => <LinkRow key={l.id} l={l} />)
      )}
    </Panel>
  );
}
