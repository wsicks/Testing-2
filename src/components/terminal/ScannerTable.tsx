"use client";

// Market scanner: dense filterable table over live Gamma data with grades,
// signal scores and tradability flags.

import { useState } from "react";
import Link from "next/link";
import {
  useMarkets,
  usePatchSettings,
  useSettings,
  type ScannerFilters,
  type ScannerRow,
} from "@/hooks/api";
import { useTerminal } from "@/store/terminal";
import { fmtCents, fmtSignedPct, fmtTimeUntil, fmtUsd } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Num } from "@/components/ui/num";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyNote, Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Star } from "lucide-react";

const COLS: { key: string; label: string; sortable?: string }[] = [
  { key: "watch", label: "" },
  { key: "market", label: "market" },
  { key: "yes", label: "yes" },
  { key: "no", label: "no" },
  { key: "mid", label: "mid", sortable: "price" },
  { key: "bid", label: "bid" },
  { key: "ask", label: "ask" },
  { key: "spread", label: "sprd", sortable: "spread" },
  { key: "liq", label: "liq", sortable: "liquidity" },
  { key: "vol", label: "vol 24h", sortable: "volume24h" },
  { key: "close", label: "close", sortable: "closeTime" },
  { key: "chg", label: "Δ24h", sortable: "change" },
  { key: "sig", label: "sig", sortable: "signal" },
  { key: "grade", label: "grd" },
  { key: "trad", label: "status" },
];

export function ScannerTable({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const [filters, setFilters] = useState<ScannerFilters>({
    sort: "volume24h",
    dir: "desc",
    limit: compact ? 25 : 100,
  });
  const { data, isLoading, isError } = useMarkets(filters);
  const { data: settingsData } = useSettings();
  const patchSettings = usePatchSettings();
  const selectMarket = useTerminal((s) => s.selectMarket);
  const selected = useTerminal((s) => s.selectedConditionId);

  const set = (patch: Partial<ScannerFilters>) =>
    setFilters((f) => ({ ...f, ...patch }));

  const toggleWatch = (row: ScannerRow) => {
    const list = settingsData?.settings.watchlist ?? [];
    const next = list.includes(row.conditionId)
      ? list.filter((x) => x !== row.conditionId)
      : [...list, row.conditionId];
    patchSettings.mutate({ watchlist: next });
  };

  return (
    <Panel
      title={`market scanner ${data ? `(${data.markets.length}/${data.total})` : ""}`}
      className={className}
      right={
        <>
          {data?.source === "mock" ? (
            <Badge variant="warn">mock data — api offline</Badge>
          ) : null}
          {isLoading ? <Spinner /> : null}
        </>
      }
      bodyClassName="flex flex-col gap-1 p-0"
    >
      {!compact && (
        <div className="flex flex-wrap items-end gap-1.5 border-b border-line bg-paper p-1.5">
          <Input
            placeholder="search markets…"
            className="w-44"
            value={filters.q ?? ""}
            onChange={(e) => set({ q: e.target.value || undefined })}
          />
          <Select
            className="w-32"
            value={filters.tag ?? ""}
            onChange={(e) => set({ tag: e.target.value || undefined })}
          >
            <option value="">all categories</option>
            {data?.categories.map((c) => (
              <option key={c.label} value={c.label.toLowerCase()}>
                {c.label} ({c.count})
              </option>
            ))}
          </Select>
          <Select
            className="w-32"
            value={filters.closingHrs ?? ""}
            onChange={(e) =>
              set({ closingHrs: e.target.value ? Number(e.target.value) : undefined })
            }
          >
            <option value="">any close time</option>
            <option value="6">closing &lt; 6h</option>
            <option value="24">closing &lt; 24h</option>
            <option value="72">closing &lt; 3d</option>
            <option value="168">closing &lt; 7d</option>
          </Select>
          <Input
            type="number"
            placeholder="min liq $"
            className="w-20"
            value={filters.minLiquidity ?? ""}
            onChange={(e) =>
              set({ minLiquidity: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <Input
            type="number"
            placeholder="min vol $"
            className="w-20"
            value={filters.minVolume ?? ""}
            onChange={(e) =>
              set({ minVolume: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <Input
            type="number"
            step="0.01"
            placeholder="max sprd"
            className="w-20"
            value={filters.maxSpread ?? ""}
            onChange={(e) =>
              set({ maxSpread: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <Input
            type="number"
            step="0.05"
            placeholder="px ≥"
            className="w-16"
            value={filters.priceMin ?? ""}
            onChange={(e) =>
              set({ priceMin: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <Input
            type="number"
            step="0.05"
            placeholder="px ≤"
            className="w-16"
            value={filters.priceMax ?? ""}
            onChange={(e) =>
              set({ priceMax: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          {(
            [
              ["newOnly", "new"],
              ["highMovement", "movers"],
              ["watchlistOnly", "watchlist"],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="xs"
              variant={filters[key] ? "primary" : "default"}
              onClick={() => set({ [key]: !filters[key] || undefined })}
            >
              {label}
            </Button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {isError ? (
          <EmptyNote>failed to load markets — check API health</EmptyNote>
        ) : (
          <table className="w-full border-collapse text-2xs">
            <thead className="sticky top-0 z-10 bg-paper">
              <tr className="border-b border-line-strong text-left">
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    className={cn(
                      "cell label cursor-default font-semibold",
                      c.sortable && "cursor-pointer hover:text-ink",
                    )}
                    onClick={() =>
                      c.sortable &&
                      set({
                        sort: c.sortable,
                        dir:
                          filters.sort === c.sortable && filters.dir === "desc"
                            ? "asc"
                            : "desc",
                      })
                    }
                  >
                    {c.label}
                    {c.sortable && filters.sort === c.sortable
                      ? filters.dir === "desc"
                        ? " ▾"
                        : " ▴"
                      : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.markets.map((m) => (
                <tr
                  key={m.conditionId}
                  className={cn(
                    "cursor-pointer border-b border-line/60 hover:bg-paper",
                    selected === m.conditionId && "bg-accent-soft/60",
                  )}
                  onClick={() => selectMarket(m.conditionId)}
                >
                  <td className="cell w-5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleWatch(m);
                      }}
                      title={m.watchlisted ? "remove from watchlist" : "add to watchlist"}
                    >
                      <Star
                        size={10}
                        className={
                          m.watchlisted
                            ? "fill-warn text-warn"
                            : "text-line-strong hover:text-warn"
                        }
                      />
                    </button>
                  </td>
                  <td className="max-w-64 truncate px-2 py-1" title={m.question}>
                    <Link
                      href={`/market/${m.conditionId}`}
                      className="hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {m.question}
                    </Link>
                    <div className="text-3xs text-ink-faint">
                      {m.category}
                      {m.isNew ? <Badge variant="accent" className="ml-1">new</Badge> : null}
                    </div>
                  </td>
                  <td className="cell"><Num>{fmtCents(m.yesPrice)}</Num></td>
                  <td className="cell"><Num>{fmtCents(m.noPrice)}</Num></td>
                  <td className="cell"><Num>{fmtCents(m.midpoint)}</Num></td>
                  <td className="cell"><Num tone="pos">{fmtCents(m.bestBid)}</Num></td>
                  <td className="cell"><Num tone="neg">{fmtCents(m.bestAsk)}</Num></td>
                  <td className="cell">
                    <Num tone={m.spread !== undefined && m.spread > 0.03 ? "warn" : undefined}>
                      {fmtCents(m.spread)}
                    </Num>
                  </td>
                  <td className="cell"><Num>{fmtUsd(m.liquidity, 0)}</Num></td>
                  <td className="cell"><Num>{fmtUsd(m.volume24h, 0)}</Num></td>
                  <td className="cell"><Num>{fmtTimeUntil(m.endDate)}</Num></td>
                  <td className="cell">
                    <Num tone={m.oneDayPriceChange ?? 0}>
                      {fmtSignedPct(m.oneDayPriceChange)}
                    </Num>
                  </td>
                  <td className="cell">
                    <Num tone={m.signalScore !== undefined && m.signalScore >= 60 ? "pos" : "muted"}>
                      {m.signalScore ?? "—"}
                    </Num>
                  </td>
                  <td className="cell">
                    <Badge
                      variant={
                        m.riskGrade === "A"
                          ? "pos"
                          : m.riskGrade === "B"
                            ? "accent"
                            : m.riskGrade === "C"
                              ? "warn"
                              : "neg"
                      }
                      title={m.gradeFactors.join("; ")}
                    >
                      {m.riskGrade}
                    </Badge>
                  </td>
                  <td className="cell">
                    <Badge
                      variant={
                        m.tradability === "tradable"
                          ? "pos"
                          : m.tradability === "caution"
                            ? "warn"
                            : "neg"
                      }
                    >
                      {m.tradability}
                    </Badge>
                  </td>
                </tr>
              ))}
              {data && data.markets.length === 0 ? (
                <tr>
                  <td colSpan={COLS.length}>
                    <EmptyNote>no markets match the current filters</EmptyNote>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}
