// EVIDENCE LAB — meta-analytics the machine computes about ITSELF from the
// outcome archive. Nothing here uses external data: it is the system reading
// its own measured history, which is the only place these questions can be
// answered honestly.
//
// 1) CONFLUENCE MATRIX — when strategies A and B fire on the same market
//    within a short window, is the joint forward drift better than either
//    alone? Signals are usually studied in isolation; the interaction term
//    is where portfolio-level intelligence actually lives. Lift is reported
//    with sample sizes and only for pairs above a minimum n.
//
// 2) DRIFT-BY-PRICE PROFILE — short-horizon drift bucketed by the market's
//    price level at signal time. If the venue carries a favorite–longshot
//    bias, it shows up here as negative drift in the cheap buckets and
//    positive drift in the expensive ones. IMPORTANT: this sample is
//    conditioned on OUR signals firing — a biased slice of the venue, and
//    the label says so. It calibrates our universe; it is not a general
//    claim about the venue.

import type { AlphaOutcome } from "./types";

// ── Confluence ───────────────────────────────────────────────────────────────

export interface ConfluenceCell {
  a: string;
  b: string;
  /** joint firings (same market, within the window) with a captured 1h drift */
  n: number;
  jointAvg1h: number;
  soloAvgA: number;
  soloAvgB: number;
  /** joint − best solo: positive = the combination adds information */
  lift: number;
}

export interface ConfluenceResult {
  cells: ConfluenceCell[];
  windowMs: number;
  minSamples: number;
}

const CONFLUENCE_WINDOW_MS = 15 * 60_000;
const MIN_PAIR_SAMPLES = 8;

/** direction-adjusted 1h drift, when captured */
function drift1h(o: AlphaOutcome): number | undefined {
  return o.buckets.b1h?.drift;
}

export function confluenceMatrix(outcomes: AlphaOutcome[]): ConfluenceResult {
  const withDrift = outcomes.filter((o) => drift1h(o) !== undefined);

  // solo baselines per feature
  const soloSum = new Map<string, { sum: number; n: number }>();
  for (const o of withDrift) {
    const s = soloSum.get(o.featureId) ?? { sum: 0, n: 0 };
    s.sum += drift1h(o)!;
    s.n += 1;
    soloSum.set(o.featureId, s);
  }
  const soloAvg = (id: string) => {
    const s = soloSum.get(id);
    return s && s.n > 0 ? s.sum / s.n : 0;
  };

  // joint firings: group by market, find cross-feature pairs inside the window
  const byMarket = new Map<string, AlphaOutcome[]>();
  for (const o of withDrift) {
    byMarket.set(o.conditionId, [...(byMarket.get(o.conditionId) ?? []), o]);
  }
  const pair = new Map<string, { sum: number; n: number; a: string; b: string }>();
  for (const rows of byMarket.values()) {
    const sorted = [...rows].sort((x, y) => x.createdAt - y.createdAt);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i], b = sorted[j];
        if (b.createdAt - a.createdAt > CONFLUENCE_WINDOW_MS) break;
        if (a.featureId === b.featureId) continue;
        const [ka, kb] = [a.featureId, b.featureId].sort();
        const key = `${ka}|${kb}`;
        const cell = pair.get(key) ?? { sum: 0, n: 0, a: ka, b: kb };
        // the joint observation's drift: average of the two signals' own
        // direction-adjusted drifts (they may disagree on direction — a
        // disagreeing pair SHOULD wash toward zero, which is the finding)
        cell.sum += (drift1h(a)! + drift1h(b)!) / 2;
        cell.n += 1;
        pair.set(key, cell);
      }
    }
  }

  const cells: ConfluenceCell[] = [...pair.values()]
    .filter((c) => c.n >= MIN_PAIR_SAMPLES)
    .map((c) => {
      const joint = c.sum / c.n;
      const sa = soloAvg(c.a);
      const sb = soloAvg(c.b);
      return {
        a: c.a,
        b: c.b,
        n: c.n,
        jointAvg1h: Number(joint.toFixed(4)),
        soloAvgA: Number(sa.toFixed(4)),
        soloAvgB: Number(sb.toFixed(4)),
        lift: Number((joint - Math.max(sa, sb)).toFixed(4)),
      };
    })
    .sort((x, y) => y.lift - x.lift);

  return { cells, windowMs: CONFLUENCE_WINDOW_MS, minSamples: MIN_PAIR_SAMPLES };
}

// ── Narrative half-life ──────────────────────────────────────────────────────
// Per-category repricing speed measured from OUR OWN decay curves: what
// share of the eventual 24h move was already realized at 5m and at 1h?
// Sports reprice in minutes; courts take days — one global TTL is wrong for
// both. Same honesty caveat as everything here: conditioned on our signals.

export interface CategoryHalfLife {
  category: string;
  /** rows with BOTH a 1h and 24h capture and a real 24h move (≥1c) */
  n: number;
  /** median share of the 24h move realized at 5m (undefined below sample) */
  share5m?: number;
  /** median share of the 24h move realized at 1h */
  share1h: number;
  speed: "minutes" | "hours" | "day+";
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function categoryHalfLives(outcomes: AlphaOutcome[], minN = 15): CategoryHalfLife[] {
  const byCat = new Map<string, { r1h: number[]; r5m: number[] }>();
  for (const o of outcomes) {
    if (!o.category) continue;
    const d24 = o.buckets.b24h?.drift;
    const d1 = o.buckets.b1h?.drift;
    if (d24 === undefined || d1 === undefined || Math.abs(d24) < 0.01) continue;
    const acc = byCat.get(o.category) ?? { r1h: [], r5m: [] };
    // overshoot beyond the 24h move caps at 1.5 — this is a ratio, and a
    // reverted overshoot must not read as "300% repriced"
    acc.r1h.push(Math.min(1.5, Math.abs(d1) / Math.abs(d24)));
    const d5m = o.buckets.b5m?.drift;
    if (d5m !== undefined) acc.r5m.push(Math.min(1.5, Math.abs(d5m) / Math.abs(d24)));
    byCat.set(o.category, acc);
  }
  return [...byCat.entries()]
    .filter(([, a]) => a.r1h.length >= minN)
    .map(([category, a]) => {
      const share1h = Number(median(a.r1h).toFixed(3));
      const share5m = a.r5m.length >= minN ? Number(median(a.r5m).toFixed(3)) : undefined;
      return {
        category,
        n: a.r1h.length,
        share5m,
        share1h,
        speed:
          share5m !== undefined && share5m >= 0.5
            ? ("minutes" as const)
            : share1h >= 0.5
              ? ("hours" as const)
              : ("day+" as const),
      };
    })
    .sort((x, y) => y.share1h - x.share1h);
}

// ── Drift-by-price profile ───────────────────────────────────────────────────

export interface PriceBucketDrift {
  /** bucket lower bound, e.g. 0.0, 0.1, … */
  lo: number;
  hi: number;
  /** samples with a captured 24h drift */
  n: number;
  /** samples with a captured 1h drift (fills within an hour of running) */
  n1h: number;
  /** avg RAW market drift over 24h (NOT signal-direction adjusted) */
  avgRawDrift24h: number;
  /** avg raw 1h drift */
  avgRawDrift1h: number;
}

export interface DriftProfile {
  buckets: PriceBucketDrift[];
  totalSamples: number;
  note: string;
}

export function driftByPriceProfile(outcomes: AlphaOutcome[]): DriftProfile {
  const buckets: PriceBucketDrift[] = Array.from({ length: 10 }, (_, i) => ({
    lo: i / 10,
    hi: (i + 1) / 10,
    n: 0,
    n1h: 0,
    avgRawDrift24h: 0,
    avgRawDrift1h: 0,
  }));
  const sums = buckets.map(() => ({ s24: 0, n24: 0, s1: 0, n1: 0 }));

  for (const o of outcomes) {
    const idx = Math.min(9, Math.floor(o.entryMid * 10));
    // recover RAW market drift from the direction-adjusted capture
    const sign = o.direction === "BUY_YES" ? 1 : -1;
    const d1 = o.buckets.b1h?.drift;
    const d24 = o.buckets.b24h?.drift;
    if (d1 !== undefined) {
      sums[idx].s1 += d1 * sign;
      sums[idx].n1 += 1;
    }
    if (d24 !== undefined) {
      sums[idx].s24 += d24 * sign;
      sums[idx].n24 += 1;
    }
  }
  let total = 0;
  buckets.forEach((b, i) => {
    b.n = sums[i].n24;
    b.n1h = sums[i].n1;
    total += Math.max(sums[i].n24, sums[i].n1);
    b.avgRawDrift24h = sums[i].n24 ? Number((sums[i].s24 / sums[i].n24).toFixed(4)) : 0;
    b.avgRawDrift1h = sums[i].n1 ? Number((sums[i].s1 / sums[i].n1).toFixed(4)) : 0;
  });

  return {
    buckets,
    totalSamples: total,
    note: "raw market drift by price level, sampled ONLY where our signals fired — a biased slice of the venue that calibrates our universe, not a general venue claim. A favorite–longshot bias would appear as negative drift in cheap buckets and positive in expensive ones.",
  };
}
