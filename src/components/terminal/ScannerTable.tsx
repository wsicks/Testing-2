"use client";

// Market scanner: dense, virtualized table over live Gamma data.
// Perf notes: rows render through TanStack Virtual (only visible rows mount),
// each row is memoized so a selection change re-renders two rows rather than
// the table, and the free-text filter is debounced off the critical path.

import { memo, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useVirtualizer } from "@tanstack/react-virtual";
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

const GRID =
  "18px minmax(180px,2.2fr) 52px 52px 52px 52px 52px 48px 62px 66px 58px 56px 36px 34px 72px";

const HEADERS: { label: string; sortable?: string }[] = [
  { label: "" },
  { label: "market" },
  { label: "yes" },
  { label: "no" },
  { label: "mid", sortable: "price" },
  { label: "bid" },
  { label: "ask" },
  { label: "sprd", sortable: "spread" },
  { label: "liq", sortable: "liquidity" },
  { label: "vol 24h", sortable: "volume24h" },
  { label: "close", sortable: "closeTime" },
  { label: "Δ24h", sortable: "change" },
  { label: "sig", sortable: "signal" },
  { label: "grd" },
  { label: "status" },
];

const Row = memo(function Row({
  m,
  selected,
  onSelect,
  onWatch,
}: {
  m: ScannerRow;
  selected: boolean;
  onSelect: (id: string) => void;
  onWatch: (id: string) => void;
}) {
  return (
    <div
      className={cn(
        "grid cursor-pointer items-center border-b border-line/60 text-2xs hover:bg-paper",
        selected && "bg-accent-soft/60",
      )}
      style={{ gridTemplateColumns: GRID, height: 34 }}
      onClick={() => onSelect(m.conditionId)}
    >
      <button
        className="px-1"
        onClick={(e) => {
          e.stopPropagation();
          onWatch(m.conditionId);
        }}
        title={m.watchlisted ? "remove from watchlist" : "add to watchlist"}
      >
        <Star
          size={10}
          className={m.watchlisted ? "fill-warn text-warn" : "text-line-strong hover:text-warn"}
        />
      </button>
      <div className="min-w-0 pr-1">
        <div className="truncate" title={m.question}>
          <Link
            href={`/market/${m.conditionId}`}
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {m.question}
          </Link>
        </div>
        <div className="truncate text-3xs text-ink-faint">
          {m.category}
          {m.isNew ? <span className="ml-1 text-accent">new</span> : null}
        </div>
      </div>
      <Num>{fmtCents(m.yesPrice)}</Num>
      <Num>{fmtCents(m.noPrice)}</Num>
      <Num>{fmtCents(m.midpoint)}</Num>
      <Num tone="pos">{fmtCents(m.bestBid)}</Num>
      <Num tone="neg">{fmtCents(m.bestAsk)}</Num>
      <Num tone={m.spread !== undefined && m.spread > 0.03 ? "warn" : undefined}>
        {fmtCents(m.spread)}
      </Num>
      <Num>{fmtUsd(m.liquidity, 0)}</Num>
      <Num>{fmtUsd(m.volume24h, 0)}</Num>
      <Num>{fmtTimeUntil(m.endDate)}</Num>
      <Num tone={m.oneDayPriceChange ?? 0}>{fmtSignedPct(m.oneDayPriceChange)}</Num>
      <Num tone={m.signalScore !== undefined && m.signalScore >= 60 ? "pos" : "muted"}>
        {m.signalScore ?? "—"}
      </Num>
      <Badge
        variant={
          m.riskGrade === "A" ? "pos" : m.riskGrade === "B" ? "accent" : m.riskGrade === "C" ? "warn" : "neg"
        }
        title={m.gradeFactors.join("; ")}
        className="justify-center"
      >
        {m.riskGrade}
      </Badge>
      <Badge
        variant={m.tradability === "tradable" ? "pos" : m.tradability === "caution" ? "warn" : "neg"}
        className="justify-center"
      >
        {m.tradability}
      </Badge>
    </div>
  );
});

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
    limit: compact ? 60 : 400,
  });
  // debounce free-text search off the render-critical path
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(
      () => setFilters((f) => ({ ...f, q: search || undefined })),
      250,
    );
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isError } = useMarkets(filters);
  const { data: settingsData } = useSettings();
  const patchSettings = usePatchSettings();
  const selectMarket = useTerminal((s) => s.selectMarket);
  const selected = useTerminal((s) => s.selectedConditionId);

  const parentRef = useRef<HTMLDivElement>(null);
  const rows = data?.markets ?? [];
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 34,
    overscan: 12,
  });

  const set = (patch: Partial<ScannerFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const toggleWatch = (conditionId: string) => {
    const list = settingsData?.settings.watchlist ?? [];
    const next = list.includes(conditionId)
      ? list.filter((x) => x !== conditionId)
      : [...list, conditionId];
    patchSettings.mutate({ watchlist: next });
  };

  return (
    <Panel
      title={`market scanner ${data ? `(${data.markets.length}/${data.total})` : ""}`}
      className={className}
      right={
        <>
          {data?.source === "mock" ? <Badge variant="warn">mock data — api offline</Badge> : null}
          {isLoading ? <Spinner /> : null}
        </>
      }
      bodyClassName="flex flex-col gap-0 p-0"
    >
      {!compact && (
        <div className="flex flex-wrap items-end gap-1.5 border-b border-line bg-paper p-1.5">
          <Input
            placeholder="search markets…"
            className="w-44"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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

      {/* header row */}
      <div
        className="grid border-b border-line-strong bg-paper"
        style={{ gridTemplateColumns: GRID }}
      >
        {HEADERS.map((c, i) => (
          <button
            key={i}
            className={cn(
              "label px-0.5 py-1 text-left",
              c.sortable && "cursor-pointer hover:text-ink",
            )}
            disabled={!c.sortable}
            onClick={() =>
              c.sortable &&
              set({
                sort: c.sortable,
                dir: filters.sort === c.sortable && filters.dir === "desc" ? "asc" : "desc",
              })
            }
          >
            {c.label}
            {c.sortable && filters.sort === c.sortable ? (filters.dir === "desc" ? " ▾" : " ▴") : ""}
          </button>
        ))}
      </div>

      {/* virtualized body */}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        {isError ? (
          <EmptyNote>failed to load markets — check API health</EmptyNote>
        ) : rows.length === 0 && !isLoading ? (
          <EmptyNote>no markets match the current filters</EmptyNote>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const m = rows[vi.index];
              return (
                <div
                  key={m.conditionId}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <Row
                    m={m}
                    selected={selected === m.conditionId}
                    onSelect={selectMarket}
                    onWatch={toggleWatch}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}
