"use client";

// Data-source transparency page: license, cadence, rate-limit posture, live
// success/failure counters, freshness and data class per external source —
// plus CoinGecko reference prices, clearly labeled reference-only.

import { usePatchSettings, useSettings, useSources } from "@/hooks/api";
import { fmtAgo, fmtUsd } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Num } from "@/components/ui/num";
import { Switch } from "@/components/ui/switch";
import { EmptyNote, Spinner } from "@/components/ui/spinner";

const VENUE_LABEL: Record<string, string> = {
  polymarket: "Polymarket",
  kalshi: "Kalshi",
  coinbase: "Coinbase",
  coingecko: "CoinGecko",
};

export default function SourcesPage() {
  const { data, isLoading } = useSources();
  const { data: settingsData } = useSettings();
  const patch = usePatchSettings();
  const venues = settingsData?.settings.venues;

  return (
    <div className="space-y-2">
      <Panel
        title="external data sources"
        right={isLoading ? <Spinner /> : undefined}
        bodyClassName="p-0"
      >
        <table className="w-full text-2xs">
          <thead>
            <tr className="border-b border-line-strong text-left">
              {["source", "class", "license / terms", "cadence", "rate limits", "requests", "failures", "last ok", "last fail", "freshness", "public data"].map((h) => (
                <th key={h} className="cell label">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.sources.map((s) => {
              const vcfg = venues?.[s.venueId as keyof typeof venues];
              return (
                <tr key={s.venueId} className="border-b border-line/60 align-top">
                  <td className="cell font-semibold">{s.name}</td>
                  <td className="cell">
                    <Badge variant={s.dataClass === "tradable" ? "pos" : "warn"}>
                      {s.dataClass === "tradable" ? "tradable venue" : "reference-only"}
                    </Badge>
                  </td>
                  <td className="max-w-64 px-2 py-1 text-ink-soft">{s.licenseNote}</td>
                  <td className="cell text-ink-soft">{s.updateFrequency}</td>
                  <td className="max-w-44 px-2 py-1 text-ink-soft">{s.rateLimitNote}</td>
                  <td className="cell"><Num>{s.requests}</Num></td>
                  <td className="cell">
                    <Num tone={s.failures > 0 ? "warn" : "muted"}>{s.failures}</Num>
                  </td>
                  <td className="cell"><Num className="text-ink-faint">{fmtAgo(s.lastSuccessAt)}</Num></td>
                  <td className="cell">
                    <Num tone={s.lastFailureAt ? "warn" : "muted"} className="text-ink-faint">
                      {fmtAgo(s.lastFailureAt)}
                    </Num>
                    {s.lastError ? (
                      <div className="max-w-40 truncate text-3xs text-neg" title={s.lastError}>
                        {s.lastError}
                      </div>
                    ) : null}
                  </td>
                  <td className="cell">
                    <Num tone={s.freshnessMs !== undefined && s.freshnessMs > 60_000 ? "warn" : undefined}>
                      {s.freshnessMs !== undefined ? `${Math.round(s.freshnessMs / 1000)}s` : "never"}
                    </Num>
                  </td>
                  <td className="cell">
                    {vcfg ? (
                      <Switch
                        checked={vcfg.publicData}
                        onCheckedChange={(v) =>
                          patch.mutate({
                            venues: { ...venues!, [s.venueId]: { ...vcfg, publicData: v } },
                          })
                        }
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="border-t border-line px-2 py-1 text-3xs text-ink-faint">
          Reference-only sources can influence signals but can NEVER submit
          orders. Live execution requires fresh official data from the venue
          where the order is placed. No source is scraped; all rate limits are
          respected via caching.
        </p>
      </Panel>

      <Panel title="coingecko reference prices — reference-only" bodyClassName="p-0">
        {!data?.referencePrices.length ? (
          <EmptyNote>no reference prices loaded</EmptyNote>
        ) : (
          <table className="w-full text-2xs">
            <thead>
              <tr className="border-b border-line-strong text-left">
                {["asset", "price", "24h change", "24h volume", "as of", "class"].map((h) => (
                  <th key={h} className="cell label">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.referencePrices.map((r) => (
                <tr key={r.symbol} className="border-b border-line/60">
                  <td className="cell font-semibold">{r.symbol}</td>
                  <td className="cell"><Num>${r.price.toLocaleString()}</Num></td>
                  <td className="cell">
                    <Num tone={r.change24hPct ?? 0}>
                      {r.change24hPct !== undefined ? `${(r.change24hPct * 100).toFixed(2)}%` : "—"}
                    </Num>
                  </td>
                  <td className="cell"><Num>{fmtUsd(r.volume24h, 0)}</Num></td>
                  <td className="cell"><Num className="text-ink-faint">{fmtAgo(r.ts)}</Num></td>
                  <td className="cell"><Badge variant="warn">reference-only</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
