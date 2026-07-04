"use client";

// Autopilot command center — mode control, arming ritual, session envelope,
// Thompson-bandit allocation (real posteriors from realized exits), and the
// decision tape. Every number here is computed from actual engine state.

import { useEffect, useState } from "react";
import {
  useArmAutopilot,
  useAutopilot,
  useDisarmAutopilot,
  usePatchSettings,
  useSettings,
} from "@/hooks/api";
import type { AutopilotConfig, AutopilotMode } from "@/lib/types";
import { STRATEGIES } from "@/lib/engine/signals/registry";
import { fmtAgo, fmtSignedUsd, fmtTime, fmtUsd } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Num } from "@/components/ui/num";
import { EmptyNote, Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const MODES: { key: AutopilotMode; label: string; hint: string }[] = [
  { key: "off", label: "off", hint: "engine idle" },
  { key: "observe", label: "observe", hint: "decisions logged, nothing executed" },
  { key: "paper", label: "paper", hint: "fully automated simulated trading" },
  { key: "live", label: "live", hint: "requires live gate + ARM ritual" },
];

function Chip({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "pos" | "neg" | "warn" }) {
  return (
    <div className="border border-line bg-paper px-2 py-1">
      <div className="label">{label}</div>
      <div className="text-sm">
        <Num tone={tone}>{value}</Num>
      </div>
    </div>
  );
}

export function AutopilotPanel({ full = false }: { full?: boolean }) {
  const { data: status, isLoading } = useAutopilot();
  const { data: settingsData } = useSettings();
  const patch = usePatchSettings();
  const arm = useArmAutopilot();
  const disarm = useDisarmAutopilot();
  const [armText, setArmText] = useState("");
  const [armTtl, setArmTtl] = useState("60");
  const [cfg, setCfg] = useState<AutopilotConfig | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (status?.config && !cfg) setCfg(status.config);
  }, [status?.config, cfg]);

  const config = status?.config;
  const session = status?.session;
  const armed = session?.armedUntil !== undefined && session.armedUntil > now;
  const nextTickIn = session?.lastTickAt
    ? Math.max(0, Math.round((session.lastTickAt + 30_000 - now) / 1000))
    : undefined;
  const paceHr = session?.tradesLastHour ?? 0;

  const setMode = (mode: AutopilotMode) => {
    if (!config) return;
    if (mode === "paper" && config.mode !== "paper") {
      if (
        !window.confirm(
          "Enable PAPER autopilot? The engine will autonomously enter and exit simulated positions against real market data within the configured envelope. No real funds are involved.",
        )
      )
        return;
    }
    if (mode === "live" && config.mode !== "live") {
      if (
        !window.confirm(
          "Set autopilot mode to LIVE? This alone does NOT trade: you must additionally ARM the session below (typed phrase, time-boxed), the live gate must be open, and every order still passes the risk engine. Real funds would be at risk while armed.",
        )
      )
        return;
    }
    patch.mutate({ autopilot: { ...config, mode } });
  };

  return (
    <div className={cn("grid grid-cols-1 gap-2", full && "xl:grid-cols-3")}>
      <Panel
        title="autopilot engine"
        className={full ? "xl:col-span-2" : undefined}
        right={
          <>
            {isLoading ? <Spinner /> : null}
            <Badge
              variant={
                config?.mode === "live"
                  ? armed
                    ? "neg"
                    : "warn"
                  : config?.mode === "paper"
                    ? "pos"
                    : config?.mode === "observe"
                      ? "accent"
                      : "default"
              }
            >
              {config?.mode ?? "…"}
              {config?.mode === "live" ? (armed ? " · ARMED" : " · disarmed") : ""}
            </Badge>
            {session?.breakerTripped ? <Badge variant="neg">breaker tripped</Badge> : null}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-1">
          {MODES.map((m) => (
            <Button
              key={m.key}
              size="sm"
              title={m.hint}
              variant={config?.mode === m.key ? (m.key === "live" ? "danger" : "primary") : "default"}
              onClick={() => setMode(m.key)}
            >
              {m.label}
            </Button>
          ))}
          <span className="ml-2 text-3xs text-ink-faint">
            {MODES.find((m) => m.key === config?.mode)?.hint}
          </span>
        </div>

        <div className="mt-2 grid grid-cols-3 gap-1 md:grid-cols-6">
          <Chip label="pace (entries/hr)" value={`${paceHr}/${config?.maxTradesPerHour ?? "—"}`} />
          <Chip label="next tick" value={nextTickIn !== undefined ? `${nextTickIn}s` : "—"} />
          <Chip label="in-flight lots" value={`${status?.managedPositions ?? 0}/${config?.maxOpenPositions ?? "—"}`} />
          <Chip
            label="session notional"
            value={`${fmtUsd(session?.notionalUsd ?? 0, 0)}/${fmtUsd(config?.maxSessionNotionalUsd ?? 0, 0)}`}
          />
          <Chip
            label="session pnl (realized)"
            value={fmtSignedUsd(session?.realizedPnlUsd ?? 0)}
            tone={(session?.realizedPnlUsd ?? 0) > 0 ? "pos" : (session?.realizedPnlUsd ?? 0) < 0 ? "neg" : undefined}
          />
          <Chip
            label="breaker at"
            value={`-${fmtUsd(config?.sessionMaxLossUsd ?? 0, 0)}`}
            tone={session?.breakerTripped ? "neg" : undefined}
          />
        </div>
        {session?.breakerTripped ? (
          <div className="mt-1 border border-neg bg-neg-soft p-1.5 text-2xs text-neg">
            CIRCUIT BREAKER: {session.breakerReason} — entries halted, exits keep
            running. Reset the session to resume.
          </div>
        ) : null}

        {/* live arming ritual */}
        {config?.mode === "live" ? (
          <div className="mt-2 border border-neg/50 bg-neg-soft/50 p-2">
            <div className="label mb-1 text-neg">live arming — pre-authorized automation window</div>
            {armed ? (
              <div className="flex items-center gap-2 text-2xs">
                <Badge variant="neg">ARMED until {fmtTime(session?.armedUntil)}</Badge>
                <Button size="xs" variant="danger" onClick={() => disarm.mutate({})}>
                  disarm now
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <Field label={'type "ARM LIVE AUTOPILOT"'}>
                  <Input value={armText} onChange={(e) => setArmText(e.target.value)} className="w-56" />
                </Field>
                <Field label="ttl (minutes)">
                  <Input type="number" value={armTtl} onChange={(e) => setArmTtl(e.target.value)} className="w-20" />
                </Field>
                <Button
                  variant="danger"
                  disabled={arm.isPending || armText.trim().toUpperCase() !== "ARM LIVE AUTOPILOT"}
                  onClick={() => arm.mutate({ confirmation: armText, ttlMinutes: Number(armTtl) || 60 })}
                >
                  arm live autopilot
                </Button>
                {!status?.liveGateOpen ? (
                  <span className="text-2xs text-neg">
                    gate closed: {status?.liveGateReasons.join("; ")}
                  </span>
                ) : null}
                {arm.data?.error ? <span className="text-2xs text-neg">{arm.data.error}</span> : null}
              </div>
            )}
            <p className="mt-1 text-3xs text-ink-soft">
              While armed, the engine may submit live limit orders inside the
              session envelope without per-order prompts — that is the point of
              arming. Every order still passes the full risk engine; the
              breaker or TTL expiry disarms automatically; arming never
              survives a restart.
            </p>
          </div>
        ) : null}

        {/* envelope config */}
        {cfg ? (
          <div className="mt-2 border-t border-line pt-2">
            <div className="label mb-1">policy envelope</div>
            <div className="grid grid-cols-2 gap-1.5 md:grid-cols-5">
              {(
                [
                  ["minScore", "min signal score"],
                  ["perTradeUsd", "per-trade $"],
                  ["maxOpenPositions", "max open lots"],
                  ["maxTradesPerHour", "max entries/hr"],
                  ["maxSessionNotionalUsd", "session notional $"],
                  ["sessionMaxLossUsd", "breaker loss $"],
                  ["targetPct", "target %"],
                  ["stopPct", "stop %"],
                  ["trailPct", "trail %"],
                  ["maxHoldMin", "max hold (min)"],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <Input
                    type="number"
                    value={cfg[key]}
                    onChange={(e) => setCfg({ ...cfg, [key]: Number(e.target.value) })}
                  />
                </Field>
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-1">
                {STRATEGIES.map((s) => {
                  const on = cfg.enabledStrategies.includes(s.id);
                  return (
                    <Button
                      key={s.id}
                      size="xs"
                      variant={on ? "primary" : "default"}
                      title={s.description}
                      onClick={() =>
                        setCfg({
                          ...cfg,
                          enabledStrategies: on
                            ? cfg.enabledStrategies.filter((x) => x !== s.id)
                            : [...cfg.enabledStrategies, s.id],
                        })
                      }
                    >
                      {s.label}
                    </Button>
                  );
                })}
              </div>
              <label className="flex items-center gap-1 text-2xs">
                <input
                  type="checkbox"
                  checked={cfg.requireRegimeMatch}
                  onChange={(e) => setCfg({ ...cfg, requireRegimeMatch: e.target.checked })}
                />
                regime gating
              </label>
              <Button
                variant="primary"
                size="sm"
                disabled={patch.isPending}
                onClick={() => patch.mutate({ autopilot: cfg })}
              >
                save envelope
              </Button>
              <Button size="sm" onClick={() => disarm.mutate({ resetSession: true })}>
                reset session
              </Button>
            </div>
          </div>
        ) : null}
      </Panel>

      {/* bandit allocation */}
      <Panel
        title="strategy allocation — thompson bandit"
        right={<Badge variant="accent">learned from realized exits</Badge>}
      >
        {!status?.bandit.length ? (
          <EmptyNote>no bandit state yet</EmptyNote>
        ) : (
          <div className="space-y-1.5">
            {status.bandit.map((b) => {
              const total = b.wins + b.losses;
              return (
                <div key={b.strategy} className="text-2xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{b.strategy}</span>
                    <span className="num text-ink-faint">
                      {b.wins}W/{b.losses}L{" "}
                      <Num tone={b.realizedPnlUsd}>{fmtSignedUsd(b.realizedPnlUsd)}</Num>
                    </span>
                  </div>
                  <div className="relative mt-0.5 h-2 border border-line bg-paper">
                    <div
                      className="absolute inset-y-0 left-0 bg-accent/25"
                      style={{ width: `${(b.mean * 100).toFixed(1)}%` }}
                    />
                    <div
                      className="absolute inset-y-0 w-px bg-ink"
                      style={{ left: `${((b.sampled ?? b.mean) * 100).toFixed(1)}%` }}
                      title={`last Thompson sample ${(100 * (b.sampled ?? 0)).toFixed(1)}%`}
                    />
                  </div>
                  <div className="flex justify-between text-3xs text-ink-faint">
                    <span>posterior mean {(b.mean * 100).toFixed(1)}%</span>
                    <span>{total === 0 ? "no realized trades yet — exploring" : `${total} realized`}</span>
                  </div>
                </div>
              );
            })}
            <p className="text-3xs text-ink-faint">
              Beta(α,β) posteriors over per-trade win probability, updated only
              by realized autopilot exits. Bars show posterior mean; the tick is
              the latest Thompson sample used for ranking.
            </p>
          </div>
        )}
      </Panel>

      {/* decision tape */}
      <Panel
        title={`decision tape (${status?.decisions.length ?? 0})`}
        className={full ? "xl:col-span-3" : undefined}
        bodyClassName="max-h-72 overflow-y-auto p-0"
      >
        {!status?.decisions.length ? (
          <EmptyNote>
            no decisions yet — enable observe or paper mode and the engine will
            narrate every entry, exit and skip with its reason
          </EmptyNote>
        ) : (
          <ul>
            {status.decisions.map((d) => (
              <li
                key={d.id}
                className={cn(
                  "flex items-start gap-1.5 border-b border-line/60 px-2 py-0.5 text-2xs",
                  d.kind === "halt" && "bg-neg-soft",
                  d.kind === "entry" && "bg-pos-soft/40",
                  d.kind === "exit" && "bg-accent-soft/40",
                )}
              >
                <span className="num shrink-0 text-ink-faint">{fmtAgo(d.ts)}</span>
                <Badge
                  variant={
                    d.kind === "entry"
                      ? "pos"
                      : d.kind === "exit"
                        ? "accent"
                        : d.kind === "halt"
                          ? "neg"
                          : d.kind === "arm" || d.kind === "disarm"
                            ? "warn"
                            : "default"
                  }
                  className="w-12 shrink-0 justify-center"
                >
                  {d.kind}
                </Badge>
                {d.strategy ? (
                  <span className="w-28 shrink-0 truncate font-semibold">{d.strategy}</span>
                ) : null}
                <span className="min-w-0 flex-1 break-words">
                  {d.marketQuestion ? (
                    <span className="font-semibold">{d.marketQuestion.slice(0, 50)} — </span>
                  ) : null}
                  {d.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {settingsData?.settings.killSwitch ? (
        <div className="border border-neg bg-neg-soft p-2 text-2xs text-neg xl:col-span-3">
          KILL SWITCH is engaged — the autopilot engine is fully halted.
        </div>
      ) : null}
    </div>
  );
}
