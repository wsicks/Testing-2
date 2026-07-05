"use client";

// Data-source transparency page: license, cadence, rate-limit posture, live
// success/failure counters, freshness and data class per external source —
// plus CoinGecko reference prices, clearly labeled reference-only.

import {
  useAlphaSources,
  usePatchSettings,
  useSettings,
  useSourceHealthCheck,
  useSources,
} from "@/hooks/api";
import { fmtAgo, fmtUsd } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Num } from "@/components/ui/num";
import { Switch } from "@/components/ui/switch";
import { EmptyNote, Spinner } from "@/components/ui/spinner";

const REG_STATUS_TONE: Record<string, "pos" | "neg" | "warn" | "default"> = {
  active: "pos",
  degraded: "warn",
  disabled: "default",
  manual_review: "warn",
  banned: "neg",
  unavailable: "neg",
};

export default function SourcesPage() {
  const { data, isLoading } = useSources();
  const { data: registry } = useAlphaSources();
  const healthCheck = useSourceHealthCheck();
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

      <Panel
        title={`free api radar — source registry (${registry?.sources.length ?? 0})`}
        right={
          <Button size="xs" onClick={() => healthCheck.mutate()} disabled={healthCheck.isPending}>
            {healthCheck.isPending ? "checking…" : "run health checks"}
          </Button>
        }
        bodyClassName="p-0"
      >
        <table className="w-full text-2xs">
          <thead>
            <tr className="border-b border-line-strong text-left">
              {["source", "category", "status", "free", "key", "rate limit", "cadence", "reliability", "latency", "last ok", "terms review", "note"].map((h) => (
                <th key={h} className="cell label">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {registry?.sources.map((s) => (
              <tr key={s.sourceId} className="border-b border-line/60 align-top">
                <td className="cell font-semibold">
                  {s.docsUrl ? (
                    <a href={s.docsUrl} target="_blank" rel="noreferrer" className="hover:underline">{s.sourceName}</a>
                  ) : s.sourceName}
                  {s.officialSource ? <span className="pl-1 text-3xs text-ink-faint">official</span> : null}
                </td>
                <td className="cell text-ink-soft">{s.category.replace(/_/g, " ")}</td>
                <td className="cell"><Badge variant={REG_STATUS_TONE[s.status] ?? "default"}>{s.status.replace(/_/g, " ")}</Badge></td>
                <td className="cell">{s.freeAvailable ? "yes" : "no"}</td>
                <td className="cell text-ink-soft">{s.apiKeyRequired ? (s.apiKeyEnvVar ?? "required") : "none"}</td>
                <td className="max-w-44 px-2 py-1 text-ink-soft">{s.rateLimit}</td>
                <td className="cell text-ink-soft">{s.updateFrequency}</td>
                <td className="cell"><Num tone={s.reliabilityScore >= 0.7 ? "pos" : s.reliabilityScore < 0.4 ? "warn" : undefined}>{(s.reliabilityScore * 100).toFixed(0)}%</Num></td>
                <td className="cell"><Num className="text-ink-faint">{s.lastLatencyMs !== undefined ? `${s.lastLatencyMs}ms` : "—"}</Num></td>
                <td className="cell"><Num className="text-ink-faint">{fmtAgo(s.lastSuccessfulCall)}</Num></td>
                <td className="cell"><Num className="text-ink-faint">{fmtAgo(s.lastTermsReview)}</Num></td>
                <td className="max-w-64 px-2 py-1 text-3xs text-ink-faint">{s.note ?? s.allowedUse}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-line px-2 py-1 text-3xs text-ink-faint">
          Statuses are honest: disabled = free key not configured (env var
          listed), manual_review = no permitted structured API (never scraped),
          unavailable = no permitted source exists (sports). Reliability moves
          with observed health-check outcomes.
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
