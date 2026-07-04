// Strategy 7 — Microstructure flow.
// Combines micro-price divergence (where the top of book leans), near-mid
// depth imbalance, and aggressor imbalance on the public tape into a
// short-horizon pressure read. Fires only when all three components agree
// and the book is deep enough that the read means something.

import type { SignalContext, SignalResult, SignalStrategy } from "@/lib/types";
import { computeMicroMetrics } from "../micro/microstructure";
import { buildSignal, check, ramp } from "./helpers";

const PRESSURE_ENTRY = 0.35;

export const microstructureSignal: SignalStrategy = {
  id: "microstructure",
  label: "Microstructure Flow",
  description:
    "Micro-price divergence + book imbalance + tape aggressor imbalance. Short-horizon pressure read; fires only when the components agree.",

  run(ctx: SignalContext): SignalResult | null {
    const { market, book, trades, settings, now } = ctx;
    if (!book) return null;
    const m = computeMicroMetrics(book, trades ?? [], now);
    if (!m) return null;
    if (Math.abs(m.pressure) < PRESSURE_ENTRY) return null;

    const depth = book.bidDepthUsd + book.askDepthUsd;
    const agree =
      Math.sign(m.microDivergence) === Math.sign(m.pressure) &&
      (m.tapeImbalance === 0 || Math.sign(m.tapeImbalance) === Math.sign(m.pressure));

    const checks = [
      check(
        "pressure_threshold",
        Math.abs(m.pressure) >= PRESSURE_ENTRY,
        `Composite pressure ${(m.pressure * 100).toFixed(0)}% (entry ±${PRESSURE_ENTRY * 100}%)`,
        Math.abs(m.pressure),
        PRESSURE_ENTRY,
      ),
      check(
        "components_agree",
        agree,
        `micro-div ${(m.microDivergence * 100).toFixed(2)}c, book ${(m.bookImbalance * 100).toFixed(0)}%, tape ${(m.tapeImbalance * 100).toFixed(0)}% ($${Math.round(m.tapeVolumeUsd).toLocaleString()} on ${m.tradesUsed} trades)`,
      ),
      check(
        "book_depth",
        depth >= 2_000,
        `Near-mid depth $${Math.round(depth).toLocaleString()} vs min $2,000 — imbalance on a thin book is noise`,
        depth,
        2_000,
      ),
      check(
        "tape_sample",
        m.tradesUsed >= 5,
        `${m.tradesUsed} trades in the last hour (min 5 for a tape read)`,
        m.tradesUsed,
        5,
      ),
      check(
        "spread_sane",
        (book.spread ?? 1) <= settings.maxSpread,
        `Spread ${((book.spread ?? 1) * 100).toFixed(1)}c vs max ${(settings.maxSpread * 100).toFixed(1)}c`,
        book.spread,
        settings.maxSpread,
      ),
      check(
        "not_boundary",
        m.mid > 0.05 && m.mid < 0.95,
        `Mid ${(m.mid * 100).toFixed(1)}c must be inside the 5–95c band — flow reads at the boundary are lottery tickets`,
        m.mid,
      ),
    ];

    const direction = m.pressure > 0 ? "BUY_YES" : "BUY_NO";
    const score =
      55 * ramp(Math.abs(m.pressure), PRESSURE_ENTRY, 0.9) +
      25 * (agree ? 1 : 0) +
      20 * ramp(Math.log10(Math.max(1, depth)), 3, 5);

    // short-horizon fair value = micro-price (bounded), used for sizing
    const microFair = Math.min(0.99, Math.max(0.01, m.microPrice));

    return buildSignal({
      strategy: this.id,
      strategyLabel: this.label,
      market,
      direction,
      score,
      summary: `Flow pressure ${(m.pressure * 100).toFixed(0)}% toward ${direction === "BUY_YES" ? "YES" : "NO"} — micro ${(m.microPrice * 100).toFixed(1)}c vs mid ${(m.mid * 100).toFixed(1)}c, tape ${(m.tapeImbalance * 100).toFixed(0)}%`,
      checks,
      now,
      ttlMs: 5 * 60_000,
      meta: {
        ...m,
        modelWinProb: direction === "BUY_YES" ? microFair : 1 - microFair,
      },
    });
  },
};
