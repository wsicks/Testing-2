"use client";

import { useEffect, useState } from "react";
import { usePatchSettings, useSettings } from "@/hooks/api";
import type { AppSettings } from "@/lib/types";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

type NumericKey =
  | "maxTradePct"
  | "maxTradeUsd"
  | "maxDailyLossUsd"
  | "maxMarketExposurePct"
  | "maxCategoryExposurePct"
  | "minLiquidityUsd"
  | "maxSpread"
  | "minSignalScore"
  | "orderExpirationMin"
  | "kellyCap"
  | "feeRateBps"
  | "slippageBps"
  | "typedConfirmThresholdUsd"
  | "staleDataMaxSecs"
  | "closingSoonHours"
  | "paperStartingCash"
  | "liveDeclaredCashUsd";

const FIELDS: { key: NumericKey; label: string; step?: string; hint: string }[] = [
  { key: "maxTradePct", label: "max trade (% of portfolio)", step: "0.25", hint: "default 1% — hard per-trade cap" },
  { key: "maxTradeUsd", label: "max trade ($ absolute)", hint: "the lower of the two caps applies" },
  { key: "maxDailyLossUsd", label: "max daily loss ($)", hint: "trading blocks when worst-case breaches this" },
  { key: "maxMarketExposurePct", label: "max market exposure (%)", step: "0.5", hint: "default 5% per market" },
  { key: "maxCategoryExposurePct", label: "max category exposure (%)", step: "0.5", hint: "default 15% per category" },
  { key: "minLiquidityUsd", label: "min market liquidity ($)", hint: "no trade below this liquidity" },
  { key: "maxSpread", label: "max spread (price)", step: "0.005", hint: "e.g. 0.03 = 3 cents" },
  { key: "minSignalScore", label: "min signal score", hint: "signal-attached orders below this are blocked" },
  { key: "orderExpirationMin", label: "order expiration (min)", hint: "resting orders auto-expire" },
  { key: "kellyCap", label: "kelly cap (fraction)", step: "0.05", hint: "0.25 = quarter-Kelly sizing" },
  { key: "feeRateBps", label: "fee assumption (bps)", hint: "used in EV/required-edge math" },
  { key: "slippageBps", label: "slippage budget (bps)", hint: "used in EV/required-edge math" },
  { key: "typedConfirmThresholdUsd", label: "typed-confirm threshold ($)", hint: "live orders at/above require typing CONFIRM" },
  { key: "staleDataMaxSecs", label: "max data staleness (s)", hint: "no trade on stale market data" },
  { key: "closingSoonHours", label: "closing-soon window (h)", hint: "scanner window for near-resolution markets" },
  { key: "paperStartingCash", label: "paper starting cash ($)", hint: "applied on paper account reset" },
  { key: "liveDeclaredCashUsd", label: "DECLARED live bankroll ($)", hint: "YOUR assertion — the app holds no keys and cannot verify venue balances; used only as the live risk ceiling. $0 keeps live BUYs blocked" },
];

export default function RiskSettingsPage() {
  const { data, isLoading } = useSettings();
  const patch = usePatchSettings();
  const [draft, setDraft] = useState<Partial<AppSettings>>({});
  useEffect(() => {
    if (data) setDraft(data.settings);
  }, [data]);

  const num = (k: NumericKey) => (draft[k] as number | undefined) ?? "";

  return (
    <div className="space-y-2">
      <Panel
        title="risk settings"
        right={isLoading || patch.isPending ? <Spinner /> : undefined}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="default mode">
            <Select
              value={(draft.defaultMode as string) ?? "demo"}
              onChange={(e) =>
                setDraft((d) => ({ ...d, defaultMode: e.target.value as AppSettings["defaultMode"] }))
              }
            >
              <option value="demo">demo (sample data)</option>
              <option value="paper">paper (simulated fills, real data)</option>
              <option value="live">live (locked until enabled)</option>
            </Select>
          </Field>
          {FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              <Input
                type="number"
                step={f.step}
                value={num(f.key)}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [f.key]: Number(e.target.value) }))
                }
              />
              <span className="text-3xs text-ink-faint">{f.hint}</span>
            </Field>
          ))}
          <Field label="categories of interest (comma-separated)">
            <Input
              value={(draft.categories ?? []).join(", ")}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  categories: e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                }))
              }
            />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="primary"
            size="md"
            disabled={patch.isPending}
            onClick={() => {
              const {
                termsAcceptedAt: _t,
                killSwitch: _k,
                liveModeEnabled: _l,
                watchWallet: _w,
                scannersEnabled: _s,
                watchlist: _wl,
                ...rest
              } = draft;
              patch.mutate(rest);
            }}
          >
            save risk settings
          </Button>
          {patch.isSuccess ? <Badge variant="pos">saved</Badge> : null}
          {patch.isError ? (
            <span className="text-2xs text-neg">{(patch.error as Error).message}</span>
          ) : null}
        </div>
        <p className="mt-2 text-3xs text-ink-faint">
          Defaults enforce: paper-first, max 1%/trade, 5%/market, 15%/category,
          and hard blocks on wide spreads, thin liquidity, ambiguous resolution
          text and stale data. Loosening these increases risk — the audit log
          records every change.
        </p>
      </Panel>
    </div>
  );
}
