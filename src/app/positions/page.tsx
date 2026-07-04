"use client";

import Link from "next/link";
import { usePortfolio } from "@/hooks/api";
import { useTerminal } from "@/store/terminal";
import { fmtCents, fmtSignedUsd, fmtUsd } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Num } from "@/components/ui/num";
import { Badge } from "@/components/ui/badge";
import { EmptyNote } from "@/components/ui/spinner";
import { SampleTag } from "@/components/terminal/ModeBadge";
import { HeroMetrics } from "@/components/terminal/HeroMetrics";

export default function PositionsPage() {
  const mode = useTerminal((s) => s.mode);
  const { data } = usePortfolio(mode);
  const p = data?.portfolio;
  const open = p?.positions.filter((x) => x.size > 0) ?? [];
  const closed = p?.positions.filter((x) => x.size === 0 && x.realizedPnl !== 0) ?? [];

  return (
    <div className="space-y-2">
      <HeroMetrics />
      <Panel
        title={`open positions — ${mode} (${open.length})`}
        right={p?.isSample ? <SampleTag label="sample positions" /> : undefined}
        bodyClassName="p-0"
      >
        {open.length === 0 ? (
          <EmptyNote>no open positions in {mode} mode</EmptyNote>
        ) : (
          <table className="w-full text-2xs">
            <thead>
              <tr className="border-b border-line-strong text-left">
                {["market", "outcome", "size", "avg", "mark", "value", "unrl pnl", "rlzd pnl", "category"].map((h) => (
                  <th key={h} className="cell label">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {open.map((pos) => (
                <tr key={pos.tokenId} className="border-b border-line/60 hover:bg-paper">
                  <td className="max-w-72 truncate px-2 py-1">
                    {pos.conditionId ? (
                      <Link href={`/market/${pos.conditionId}`} className="hover:underline">
                        {pos.marketTitle ?? pos.tokenId.slice(0, 16)}
                      </Link>
                    ) : (
                      pos.marketTitle ?? pos.tokenId.slice(0, 16)
                    )}
                  </td>
                  <td className="cell"><Badge>{pos.outcome ?? "—"}</Badge></td>
                  <td className="cell"><Num>{pos.size}</Num></td>
                  <td className="cell"><Num>{fmtCents(pos.avgPrice)}</Num></td>
                  <td className="cell"><Num>{fmtCents(pos.markPrice)}</Num></td>
                  <td className="cell"><Num>{fmtUsd(pos.value)}</Num></td>
                  <td className="cell"><Num tone={pos.unrealizedPnl ?? 0}>{fmtSignedUsd(pos.unrealizedPnl)}</Num></td>
                  <td className="cell"><Num tone={pos.realizedPnl}>{fmtSignedUsd(pos.realizedPnl)}</Num></td>
                  <td className="cell text-ink-faint">{pos.category ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {closed.length > 0 ? (
        <Panel title={`closed / realized (${closed.length})`} bodyClassName="p-0">
          <table className="w-full text-2xs">
            <tbody>
              {closed.map((pos) => (
                <tr key={pos.tokenId} className="border-b border-line/60">
                  <td className="max-w-72 truncate px-2 py-1">{pos.marketTitle}</td>
                  <td className="cell"><Badge>{pos.outcome ?? "—"}</Badge></td>
                  <td className="cell">
                    <Num tone={pos.realizedPnl}>{fmtSignedUsd(pos.realizedPnl)}</Num>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
    </div>
  );
}
