// Complement-arbitrage executor (paper book only).
//
// The one mathematically locked edge this venue structure allows: when the
// YES token's book and the NO token's book of the SAME market misprice so
// that yesAsk + noAsk < $1 net of fees, buying both sides pays $1 at
// resolution whichever way it resolves. No direction, no model, no forecast
// — the discount is banked at entry.
//
// Honesty + safety rules:
//   - paper book only (live arb would need atomic two-leg execution the
//     venue adapter does not provide);
//   - both legs verified on LIVE books seconds before entry, top-of-book
//     sizes only;
//   - rule-clarity gate: a voided/ambiguous market breaks the $1 identity,
//     so unclear rules disqualify the pair;
//   - if leg 2 fails after leg 1 filled, leg 1 is unwound IMMEDIATELY at
//     the bid (a naked leg is a directional bet nobody approved);
//   - every pair is recorded with its locked net discount — the "edge" this
//     module reports is arithmetic, not a forecast.

import { complementArbOpportunity } from "@/lib/engine/arb";
import { resolutionClarity } from "@/lib/engine/signals/closingSoon";
import type { NormalizedMarket, PaperOrder } from "@/lib/types";
import { genId } from "@/lib/utils";
import { audit } from "../audit";
import { logError } from "../errorLog";
import { cancelOrder, placePaperOrder } from "../execution";
import { getBook } from "../marketData";
import { getStore } from "../store";

const KV_PAIRS = "alpha:arbPairs";
const PAIRS_CAP = 100;
/** verify at most this many candidate markets per scan tick (2 books each) */
const MAX_VERIFY_PER_TICK = 3;
/** one attempt per market per hour — books that stay crossed are suspect */
const RETRY_MS = 60 * 60_000;
/** minimum locked profit net of fees, per $1 pair */
const MIN_NET_DISCOUNT = 0.005;

export interface ArbPairRecord {
  id: string;
  conditionId: string;
  question: string;
  pairs: number;
  yesCost: number;
  noCost: number;
  /** locked profit at resolution, net of fees (USD) */
  lockedNetUsd: number;
  /** discount per pair at entry */
  netDiscount: number;
  ts: number;
  /** filled | unwound (leg-2 failure, leg 1 sold back) */
  status: "filled" | "unwound";
}

interface ArbGlobal {
  lastAttempt: Map<string, number>;
}
const g = globalThis as unknown as { __eqArb?: ArbGlobal };
const state = () => (g.__eqArb ??= { lastAttempt: new Map() });

export async function listArbPairs(): Promise<ArbPairRecord[]> {
  const store = await getStore();
  return (await store.getKV<ArbPairRecord[]>(KV_PAIRS)) ?? [];
}

async function recordPair(rec: ArbPairRecord): Promise<void> {
  const store = await getStore();
  const rows = (await store.getKV<ArbPairRecord[]>(KV_PAIRS)) ?? [];
  rows.push(rec);
  await store.setKV(KV_PAIRS, rows.slice(-PAIRS_CAP));
}

async function buyLeg(
  m: NormalizedMarket,
  tokenId: string,
  outcome: "Yes" | "No",
  price: number,
  size: number,
): Promise<PaperOrder | null> {
  const res = await placePaperOrder({
    mode: "paper",
    conditionId: m.conditionId,
    tokenId,
    outcome,
    side: "BUY",
    orderType: "limit",
    price: Number(price.toFixed(3)),
    size,
    origin: "autopilot",
  });
  if (res.rejected || !res.order) return null;
  let order = res.order;
  // IOC: an arb leg is only an arb at the verified price — never rest
  if (order.filledSize < order.size && ["open", "partially_filled", "created"].includes(order.status)) {
    const canceled = await cancelOrder(order.id, "system");
    if (canceled) order = canceled;
  }
  return order;
}

export interface ArbRunResult {
  checked: number;
  paired: number;
  lockedNetUsd: number;
}

/**
 * One arb pass: cheap hint filter over the registry, live two-book
 * verification for the best few candidates, then paired execution.
 */
export async function runArbExecutor(markets: NormalizedMarket[]): Promise<ArbRunResult> {
  const store = await getStore();
  const settings = await store.getSettings();
  if (!settings.alpha.arbEnabled || settings.killSwitch) {
    return { checked: 0, paired: 0, lockedNetUsd: 0 };
  }
  const s = state();
  const now = Date.now();

  // hint: gamma mid prices sum visibly under $1 (books may still disagree —
  // that is what the live verification decides)
  const candidates = markets
    .filter(
      (m) =>
        m.venueId === "polymarket" &&
        m.outcomeType === "binary" &&
        m.tradable &&
        !m.referenceOnly &&
        m.yesTokenId !== undefined &&
        m.noTokenId !== undefined &&
        m.yesPrice !== undefined &&
        m.noPrice !== undefined &&
        m.yesPrice + m.noPrice < 1 - MIN_NET_DISCOUNT &&
        m.liquidity >= settings.minLiquidityUsd &&
        (s.lastAttempt.get(m.conditionId) ?? 0) < now - RETRY_MS,
    )
    .sort((a, b) => a.yesPrice! + a.noPrice! - (b.yesPrice! + b.noPrice!))
    .slice(0, MAX_VERIFY_PER_TICK);

  let checked = 0,
    paired = 0,
    lockedNetUsd = 0;

  for (const m of candidates) {
    s.lastAttempt.set(m.conditionId, now);
    checked += 1;
    try {
      // a voided/ambiguous market breaks the YES+NO=$1 identity
      const clarity = resolutionClarity(m.description, m.resolutionSource);
      if (clarity.level === "low") continue;

      const [yesBook, noBook] = await Promise.all([
        getBook(m.yesTokenId!, m.yesPrice),
        getBook(m.noTokenId!, m.noPrice),
      ]);
      const opp = complementArbOpportunity(yesBook, noBook, settings.feeRateBps, MIN_NET_DISCOUNT);
      if (!opp) continue;

      const capUsd = Math.min(settings.alpha.testOrderUsd, 25);
      const pairs = Math.min(opp.maxPairs, Math.max(1, Math.floor(capUsd / opp.sum)));
      if (pairs < 1) continue;

      // leg 1: YES
      const yesOrder = await buyLeg(m, m.yesTokenId!, "Yes", opp.yesAsk, pairs);
      const yesFilled = yesOrder?.filledSize ?? 0;
      if (!yesOrder || yesFilled <= 0) continue;

      // leg 2: NO, matched to leg 1's ACTUAL fill
      const noOrder = await buyLeg(m, m.noTokenId!, "No", opp.noAsk, yesFilled);
      const noFilled = noOrder?.filledSize ?? 0;

      if (noFilled < yesFilled) {
        // pair incomplete — unwind the naked YES excess at the bid NOW
        const excess = yesFilled - noFilled;
        await placePaperOrder({
          mode: "paper",
          conditionId: m.conditionId,
          tokenId: m.yesTokenId!,
          outcome: "Yes",
          side: "SELL",
          orderType: "market",
          price: Math.max(0.01, yesBook.bestBid ?? opp.yesAsk - 0.02),
          size: excess,
          origin: "autopilot",
          isExit: true,
        }).catch(() => {});
        await audit(
          "execution",
          "arb_unwound",
          `Complement arb UNWOUND on ${m.question.slice(0, 60)}: NO leg filled ${noFilled}/${yesFilled} — naked YES excess of ${excess} sold back immediately`,
          { severity: "warn", data: { conditionId: m.conditionId } },
        );
      }

      const locked = noFilled > 0 ? Number((noFilled * opp.netDiscount).toFixed(2)) : 0;
      if (noFilled > 0) {
        paired += 1;
        lockedNetUsd += locked;
        await recordPair({
          id: genId("arb"),
          conditionId: m.conditionId,
          question: m.question,
          pairs: noFilled,
          yesCost: Number(((yesOrder.avgFillPrice ?? opp.yesAsk) * noFilled).toFixed(2)),
          noCost: Number(((noOrder?.avgFillPrice ?? opp.noAsk) * noFilled).toFixed(2)),
          lockedNetUsd: locked,
          netDiscount: opp.netDiscount,
          ts: now,
          status: noFilled < yesFilled ? "unwound" : "filled",
        });
        await audit(
          "execution",
          "arb_paired",
          `Complement arb: ${noFilled} YES+NO pair(s) on ${m.question.slice(0, 60)} at $${opp.sum.toFixed(3)}/pair — $${locked.toFixed(2)} locked at resolution net of fees (paper)`,
          { data: { conditionId: m.conditionId, pairs: noFilled, netDiscount: opp.netDiscount } },
        );
      }
    } catch (err) {
      logError("arb:executor", err, m.conditionId);
    }
  }
  return { checked, paired, lockedNetUsd: Number(lockedNetUsd.toFixed(2)) };
}
