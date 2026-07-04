"use client";

// Order ticket: preview → risk assessment → (paper fill | live intent with
// explicit confirmation). Live orders can never skip the confirmation dialog.

import { useMemo, useState } from "react";
import type { MarketDetail } from "@/hooks/api";
import {
  useConfirmIntent,
  useCreateIntent,
  usePlaceOrder,
  usePreviewOrder,
  useSettings,
} from "@/hooks/api";
import { useTerminal } from "@/store/terminal";
import type {
  ExecutionStage,
  LiveOrderIntent,
  PaperOrder,
  RiskAssessment,
} from "@/lib/types";
import { fmtCents, fmtPct, fmtUsd } from "@/lib/format";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Num } from "@/components/ui/num";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface TicketState {
  assessment?: RiskAssessment;
  order?: PaperOrder;
  intent?: LiveOrderIntent;
  previewing: boolean;
}

export function ticketStages(detailLoaded: boolean, t: TicketState): ExecutionStage[] {
  const a = t.assessment;
  return [
    {
      key: "detect",
      label: "Detect",
      status: detailLoaded ? "passed" : "waiting",
      detail: detailLoaded ? "market selected + data loaded" : "select a market",
    },
    {
      key: "validate",
      label: "Validate",
      status: t.previewing
        ? "running"
        : a
          ? a.checks.filter((c) => c.severity === "block" && !c.passed).length === 0
            ? "passed"
            : "failed"
          : "waiting",
      detail: a ? `${a.checks.filter((c) => c.passed).length}/${a.checks.length} checks` : "run preview",
    },
    {
      key: "size",
      label: "Size",
      status: a ? (a.approved ? "passed" : "failed") : "waiting",
      detail: a
        ? `kelly-capped $${a.suggestedSizeUsd.toFixed(0)} | max loss $${a.maxLossUsd.toFixed(2)}`
        : undefined,
    },
    {
      key: "execute",
      label: "Execute",
      status: t.intent
        ? t.intent.status === "approval_required" || t.intent.status === "previewed"
          ? "approval_required"
          : ["submitted", "open", "filled", "partially_filled", "confirmed"].includes(t.intent.status)
            ? "passed"
            : "failed"
        : t.order
          ? ["filled", "partially_filled", "open"].includes(t.order.status)
            ? "passed"
            : t.order.status === "rejected"
              ? "failed"
              : "running"
          : a?.approved
            ? "approval_required"
            : "waiting",
      detail: t.order
        ? `order ${t.order.status}`
        : t.intent
          ? `intent ${t.intent.status}`
          : a?.approved
            ? "user approval required"
            : undefined,
    },
    {
      key: "monitor",
      label: "Monitor/Settle",
      status: t.order
        ? t.order.status === "filled"
          ? "passed"
          : ["open", "partially_filled"].includes(t.order.status)
            ? "running"
            : "waiting"
        : "waiting",
      detail: t.order
        ? `${t.order.filledSize}/${t.order.size} filled`
        : "fills tracked on refresh",
    },
  ];
}

function CheckRow({ c }: { c: RiskAssessment["checks"][number] }) {
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 border-b border-line/60 py-0.5 text-2xs",
        !c.passed && c.severity === "block" && "bg-neg-soft",
        !c.passed && c.severity === "warn" && "bg-warn-soft/60",
      )}
    >
      <span
        className={cn(
          "num w-10 shrink-0 font-bold",
          c.passed ? "text-pos" : c.severity === "block" ? "text-neg" : "text-warn",
        )}
      >
        {c.passed ? "PASS" : c.severity === "block" ? "BLOCK" : "WARN"}
      </span>
      <span className="w-32 shrink-0 font-semibold">{c.name}</span>
      <span className="min-w-0 text-ink-soft">{c.detail}</span>
    </div>
  );
}

export function OrderTicket({
  detail,
  onState,
  className,
}: {
  detail?: MarketDetail;
  onState?: (t: TicketState) => void;
  className?: string;
}) {
  const mode = useTerminal((s) => s.mode);
  const { data: settingsData } = useSettings();
  const preview = usePreviewOrder();
  const place = usePlaceOrder();
  const createIntent = useCreateIntent();
  const confirmIntent = useConfirmIntent();

  const m = detail?.market;
  const [outcome, setOutcome] = useState<"YES" | "NO">("YES");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState<string>("");
  const [size, setSize] = useState<string>("10");
  const [winProb, setWinProb] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [state, setState] = useState<TicketState>({ previewing: false });

  const tokenId = outcome === "YES" ? m?.yesTokenId : m?.noTokenId;
  const defaultPrice =
    outcome === "YES"
      ? side === "BUY"
        ? m?.bestAsk
        : m?.bestBid
      : side === "BUY"
        ? 1 - (m?.bestBid ?? 0.5)
        : 1 - (m?.bestAsk ?? 0.5);
  const priceNum = price === "" ? Number((defaultPrice ?? 0.5).toFixed(3)) : Number(price);
  const sizeNum = Number(size) || 0;
  const notional = priceNum * sizeNum;
  const typedThreshold = settingsData?.settings.typedConfirmThresholdUsd ?? 100;
  const needsTyped = mode === "live" && notional >= typedThreshold;

  const update = (patch: Partial<TicketState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      onState?.(next);
      return next;
    });
  };

  const body = useMemo(
    () => ({
      conditionId: m?.conditionId,
      tokenId: tokenId ?? "",
      outcome,
      side,
      orderType,
      price: priceNum,
      size: sizeNum,
      winProbability: winProb ? Number(winProb) / 100 : undefined,
      signalScore: detail?.signals?.[0]?.score,
      signalId: detail?.signals?.[0]?.id,
    }),
    [m?.conditionId, tokenId, outcome, side, orderType, priceNum, sizeNum, winProb, detail?.signals],
  );

  const runPreview = async () => {
    if (!tokenId) return;
    update({ previewing: true, order: undefined, intent: undefined });
    try {
      const res = await preview.mutateAsync({ ...body, mode });
      update({ previewing: false, assessment: res.assessment });
      setOpen(true);
    } catch {
      update({ previewing: false });
    }
  };

  const submit = async () => {
    if (!state.assessment) return;
    if (mode === "live") {
      const res = await createIntent.mutateAsync(body);
      update({ intent: res.intent });
      if (res.intent.status === "previewed" || res.intent.status === "approval_required") {
        const confirmed = await confirmIntent.mutateAsync({
          id: res.intent.id,
          confirmationText: confirmText || undefined,
        });
        update({ intent: confirmed.intent });
      }
    } else {
      const res = await place.mutateAsync({ ...body, mode });
      update({ order: res.order, assessment: res.assessment });
    }
    setConfirmText("");
    setOpen(false);
  };

  const a = state.assessment;
  const busy = preview.isPending || place.isPending || createIntent.isPending || confirmIntent.isPending;

  return (
    <Panel
      title={`order ticket — ${mode}`}
      className={className}
      right={
        mode === "live" ? (
          <Badge variant="neg">live — confirmation required</Badge>
        ) : mode === "demo" ? (
          <Badge variant="warn">demo — simulated</Badge>
        ) : (
          <Badge variant="accent">paper — simulated</Badge>
        )
      }
    >
      {!m ? (
        <div className="p-2 text-2xs text-ink-faint">select a market to trade</div>
      ) : (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1">
            <div className="flex gap-0.5">
              {(["BUY", "SELL"] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  className="flex-1"
                  variant={side === s ? (s === "BUY" ? "buy" : "sell") : "default"}
                  onClick={() => setSide(s)}
                >
                  {s}
                </Button>
              ))}
            </div>
            <div className="flex gap-0.5">
              {(["YES", "NO"] as const).map((o) => (
                <Button
                  key={o}
                  size="sm"
                  className="flex-1"
                  variant={outcome === o ? "primary" : "default"}
                  onClick={() => {
                    setOutcome(o);
                    setPrice("");
                  }}
                >
                  {o}
                </Button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <Field label="type">
              <Select
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as "limit" | "market")}
              >
                <option value="limit">limit</option>
                <option value="market">market</option>
              </Select>
            </Field>
            <Field label={`price (${fmtCents(defaultPrice)} mkt)`}>
              <Input
                type="number"
                step="0.001"
                min="0.01"
                max="0.99"
                value={price === "" ? priceNum : price}
                onChange={(e) => setPrice(e.target.value)}
                disabled={orderType === "market"}
              />
            </Field>
            <Field label="size (shares)">
              <Input
                type="number"
                min="1"
                value={size}
                onChange={(e) => setSize(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <Field label="win prob % (your estimate, optional)">
              <Input
                type="number"
                min="1"
                max="99"
                placeholder="market-implied if empty"
                value={winProb}
                onChange={(e) => setWinProb(e.target.value)}
              />
            </Field>
            <div className="flex flex-col justify-end gap-0.5 text-2xs">
              <div className="flex justify-between">
                <span className="label">est. cost</span>
                <Num>{fmtUsd(notional)}</Num>
              </div>
              <div className="flex justify-between">
                <span className="label">max loss</span>
                <Num tone="neg">{side === "BUY" ? fmtUsd(notional) : "$0.00"}</Num>
              </div>
            </div>
          </div>
          <Button
            variant="primary"
            size="md"
            className="w-full"
            disabled={busy || !tokenId || sizeNum <= 0}
            onClick={runPreview}
          >
            {busy ? "working…" : "preview order & run risk checks"}
          </Button>
          {state.order ? (
            <div className="border border-line bg-paper p-1 text-2xs">
              last order:{" "}
              <Num
                tone={
                  ["filled", "partially_filled", "open"].includes(state.order.status)
                    ? "pos"
                    : "neg"
                }
              >
                {state.order.status}
              </Num>{" "}
              {state.order.filledSize}/{state.order.size} @{" "}
              {fmtCents(state.order.avgFillPrice ?? state.order.price)}
            </div>
          ) : null}
          {state.intent ? (
            <div className="border border-line bg-paper p-1 text-2xs">
              live intent: <Num tone="warn">{state.intent.status}</Num>
              {state.intent.error ? (
                <div className="text-neg">{state.intent.error}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`order preview — ${mode} mode`}>
          {a && m ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-2xs">
                <span className="text-ink-soft">{m.question}</span>
                <span className="text-right">
                  <Badge variant={a.approved ? "pos" : "neg"}>
                    {a.approved ? "risk engine: approved" : "risk engine: rejected"}
                  </Badge>
                </span>
                <Row k="side / outcome" v={`${side} ${outcome} (${orderType})`} />
                <Row k="price × size" v={`${fmtCents(a.entryPrice)} × ${sizeNum}`} />
                <Row k="est. cost" v={fmtUsd(a.estCostUsd)} />
                <Row k="max loss" v={fmtUsd(a.maxLossUsd)} neg />
                <Row k="expected value" v={fmtUsd(a.expectedValueUsd)} tone={a.expectedValueUsd} />
                <Row k="required edge" v={fmtCents(a.requiredEdge, 2)} />
                <Row k="net edge" v={fmtCents(a.netEdge, 2)} tone={a.netEdge} />
                <Row k="fill probability" v={fmtPct(a.expectedFillProbability, 0)} />
                <Row
                  k="slippage est."
                  v={fmtCents(a.slippageEstimate, 2)}
                  tone={a.slippageEstimate > 0.02 ? -1 : 0}
                />
                <Row k="kelly (full → capped)" v={`${fmtPct(a.kellyFraction)} → ${fmtPct(a.cappedKellyFraction)}`} />
                <Row k="suggested size" v={`${fmtUsd(a.suggestedSizeUsd)} (${a.suggestedShares} sh)`} />
                <Row k="exposure after" v={`${a.exposureAfterPct.toFixed(1)}% total / ${a.marketExposureAfterPct.toFixed(1)}% market / ${a.categoryExposureAfterPct.toFixed(1)}% category`} />
                <Row k="target / stop" v={`${fmtCents(a.targetPrice)} / ${fmtCents(a.stopPrice)}`} />
                <Row k="exit liquidity risk" v={a.liquidityExitRisk} tone={a.liquidityExitRisk === "high" ? -1 : 0} />
                <Row k="resolution risk" v={a.resolutionAmbiguityRisk} tone={a.resolutionAmbiguityRisk === "high" ? -1 : 0} />
                <Row
                  k="cancel policy"
                  v={`GTC, auto-expires in ${settingsData?.settings.orderExpirationMin ?? 240}m; cancellable anytime`}
                />
              </div>
              <div className="max-h-44 overflow-y-auto border border-line p-1">
                {a.checks.map((c, i) => (
                  <CheckRow key={i} c={c} />
                ))}
              </div>
              {mode === "live" ? (
                <div className="space-y-1 border border-neg bg-neg-soft p-2 text-2xs">
                  <div className="font-bold text-neg">
                    LIVE ORDER — real funds at risk. This will route to the
                    Polymarket CLOB.
                  </div>
                  {needsTyped ? (
                    <Field label={`type CONFIRM to approve (≥ $${typedThreshold})`}>
                      <Input
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        placeholder="CONFIRM"
                      />
                    </Field>
                  ) : null}
                </div>
              ) : null}
              <div className="flex justify-end gap-1.5">
                <Button onClick={() => setOpen(false)}>cancel</Button>
                <Button
                  variant={a.approved ? (side === "BUY" ? "buy" : "sell") : "default"}
                  disabled={
                    !a.approved ||
                    busy ||
                    (needsTyped && confirmText.trim().toUpperCase() !== "CONFIRM")
                  }
                  onClick={submit}
                >
                  {mode === "live"
                    ? "confirm & submit live order"
                    : `place ${mode} order`}
                </Button>
              </div>
              {!a.approved ? (
                <p className="text-2xs text-neg">
                  Rejected orders cannot be placed. Adjust the ticket or your
                  risk settings and re-preview.
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

function Row({
  k,
  v,
  tone,
  neg,
}: {
  k: string;
  v: React.ReactNode;
  tone?: number;
  neg?: boolean;
}) {
  return (
    <>
      <span className="label self-center">{k}</span>
      <span className="text-right">
        <Num tone={neg ? "neg" : tone}>{v}</Num>
      </span>
    </>
  );
}
