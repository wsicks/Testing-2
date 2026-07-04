"use client";

import { useEffect, useState } from "react";
import { useKillSwitch, usePatchSettings, useSettings } from "@/hooks/api";
import { useQueryClient } from "@tanstack/react-query";
import { useTerminal } from "@/store/terminal";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export default function ApiWalletSettingsPage() {
  const { data } = useSettings();
  const patch = usePatchSettings();
  const killSwitch = useKillSwitch();
  const setMode = useTerminal((s) => s.setMode);
  const qc = useQueryClient();
  const s = data?.settings;
  const [wallet, setWallet] = useState("");
  useEffect(() => {
    if (s?.watchWallet !== undefined) setWallet(s.watchWallet);
  }, [s?.watchWallet]);

  const reset = async (mode: "paper" | "demo") => {
    if (!window.confirm(`Reset the ${mode} account? Orders, fills and positions in ${mode} mode are deleted.`)) return;
    await fetch("/api/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    qc.invalidateQueries();
  };

  return (
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
      <Panel title="wallet — read-only analytics">
        <p className="mb-2 text-2xs text-ink-soft">
          Add a Polygon address to pull public position/trade analytics from the
          Polymarket Data API. This is read-only: no keys, no signing, no
          custody. Private keys are never stored by this app.
        </p>
        <Field label="watch wallet (0x…)">
          <Input
            value={wallet}
            placeholder="0x0000…"
            onChange={(e) => setWallet(e.target.value)}
          />
        </Field>
        <div className="mt-2 flex gap-2">
          <Button
            variant="primary"
            disabled={patch.isPending || (wallet !== "" && !/^0x[a-fA-F0-9]{40}$/.test(wallet))}
            onClick={() => patch.mutate({ watchWallet: wallet })}
          >
            save wallet
          </Button>
          {wallet !== "" && !/^0x[a-fA-F0-9]{40}$/.test(wallet) ? (
            <span className="self-center text-2xs text-neg">invalid address format</span>
          ) : null}
        </div>
      </Panel>

      <Panel title="trading mode & gates">
        <div className="space-y-2 text-2xs">
          <div className="flex items-center justify-between border border-line bg-paper p-2">
            <div>
              <div className="font-bold">scanners</div>
              <div className="text-ink-faint">background market scanning & signal generation</div>
            </div>
            <Switch
              checked={s?.scannersEnabled ?? true}
              onCheckedChange={(v) => patch.mutate({ scannersEnabled: v })}
            />
          </div>
          <div className="flex items-center justify-between border border-neg/40 bg-neg-soft p-2">
            <div>
              <div className="font-bold text-neg">kill switch</div>
              <div className="text-ink-soft">
                disables all trading, cancels open orders & live intents, stops scanners
              </div>
            </div>
            <Switch
              checked={s?.killSwitch ?? false}
              onCheckedChange={(v) => {
                if (!v || window.confirm("Engage kill switch?")) killSwitch.mutate(v);
              }}
            />
          </div>
          <div className="border border-line bg-paper p-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-bold">live mode opt-in</div>
                <div className="text-ink-faint">
                  requires BOTH this switch and LIVE_TRADING_ENABLED=true on the server
                </div>
              </div>
              <Switch
                checked={s?.liveModeEnabled ?? false}
                onCheckedChange={(v) => {
                  if (!v) {
                    patch.mutate({ liveModeEnabled: false });
                    setMode("paper");
                    return;
                  }
                  if (
                    window.confirm(
                      "RISK WARNING — enabling live mode allows routing real orders to the Polymarket CLOB after per-order confirmation. Positions can lose 100% of their value. You confirm you are eligible to trade on Polymarket in your jurisdiction and accept full responsibility. Continue?",
                    )
                  ) {
                    patch.mutate({ liveModeEnabled: true });
                  }
                }}
              />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <Badge variant={data?.liveTradingEnv ? "pos" : "default"}>
                server env {data?.liveTradingEnv ? "enabled" : "disabled"}
              </Badge>
              <Badge variant={s?.liveModeEnabled ? "warn" : "default"}>
                user opt-in {s?.liveModeEnabled ? "on" : "off"}
              </Badge>
              <Badge variant={s?.termsAcceptedAt ? "pos" : "neg"}>
                terms {s?.termsAcceptedAt ? "acknowledged" : "missing"}
              </Badge>
              <Badge variant={s?.killSwitch ? "neg" : "pos"}>
                kill switch {s?.killSwitch ? "ENGAGED" : "clear"}
              </Badge>
            </div>
            <p className="mt-1.5 text-3xs text-ink-faint">
              Even with every gate open, nothing is ever auto-submitted: each
              live order needs an explicit confirmation in the preview modal
              (typed CONFIRM at/above ${s?.typedConfirmThresholdUsd ?? 100}).
              CLOB API credentials are configured server-side via environment
              variables only — see README → Live trading.
            </p>
          </div>
        </div>
      </Panel>

      <Panel title="venues — independent per-venue controls">
        <div className="space-y-1.5 text-2xs">
          {(["polymarket", "kalshi", "coinbase"] as const).map((v) => {
            const cfg = s?.venues[v];
            if (!cfg) return null;
            return (
              <div key={v} className="flex items-center justify-between border border-line bg-paper p-2">
                <div>
                  <div className="font-bold capitalize">{v}</div>
                  <div className="text-ink-faint">
                    {v === "kalshi"
                      ? "regulated event contracts — live requires Kalshi credentials + venue terms"
                      : v === "coinbase"
                        ? "crypto spot reference/charting — live requires scoped API credentials"
                        : "event-market outcome tokens — live requires CLOB credentials"}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1">
                    <span className="label">data</span>
                    <Switch
                      checked={cfg.publicData}
                      onCheckedChange={(x) =>
                        patch.mutate({ venues: { ...s!.venues, [v]: { ...cfg, publicData: x } } })
                      }
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="label">paper</span>
                    <Switch
                      checked={cfg.paperTrading}
                      onCheckedChange={(x) =>
                        patch.mutate({ venues: { ...s!.venues, [v]: { ...cfg, paperTrading: x } } })
                      }
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="label text-neg">live</span>
                    <Switch
                      checked={cfg.liveEnabled}
                      onCheckedChange={(x) => {
                        if (
                          !x ||
                          window.confirm(
                            `Enable LIVE trading flag for ${v}? This is one of several independent gates — orders still require the global live gate, venue credentials, and per-order confirmation. Enabling one venue never enables another.`,
                          )
                        ) {
                          patch.mutate({ venues: { ...s!.venues, [v]: { ...cfg, liveEnabled: x } } });
                        }
                      }}
                    />
                  </label>
                </div>
              </div>
            );
          })}
          <p className="text-3xs text-ink-faint">
            CoinGecko is reference-only and has no trading flags. Kalshi and
            Coinbase live adapters ship locked — they fail closed with setup
            instructions until credentials are configured (see README).
          </p>
        </div>
      </Panel>

      <Panel title="accounts">
        <div className="flex flex-wrap items-center gap-2 text-2xs">
          <Button onClick={() => reset("paper")}>reset paper account</Button>
          <Button onClick={() => reset("demo")}>reset demo account</Button>
          <span className="text-ink-faint">
            paper restarts at ${s?.paperStartingCash.toLocaleString() ?? "10,000"} simulated cash
          </span>
        </div>
      </Panel>

      <Panel title="data sources">
        <ul className="space-y-1 text-2xs text-ink-soft">
          <li>• Gamma API — market discovery, events, tags, prices (public)</li>
          <li>• CLOB API — order books, midpoints, spreads, price history (public, read-only)</li>
          <li>• Data API — trade tape, wallet positions/value (public)</li>
          <li>• CLOB market websocket — client-side live book updates (public)</li>
        </ul>
        <p className="mt-2 text-3xs text-ink-faint">
          Requests are cached server-side to respect upstream rate limits. This
          terminal does not scrape private data and will not help bypass
          region, platform, or rate-limit restrictions.
        </p>
      </Panel>
    </div>
  );
}
