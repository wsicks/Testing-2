// Cross-venue mapping engine.
//
// Attempts to identify related markets across venues WITHOUT ever assuming
// equivalence from title similarity alone. Every link carries a per-dimension
// rule comparison (title terms, close time, category, threshold, resolution
// source, units, venue rules availability) and a conservative status:
//
//   exact            — never emitted by automation (reserved for human confirmation)
//   strong_candidate — parsed structure matches (asset+threshold+direction+window)
//   weak_candidate   — high term overlap + compatible window, rules unverified
//   reference_only   — event market ↔ spot product (different instrument class)
//   conflict         — structures parsed on both sides and materially disagree
//   not_comparable   — different outcome types / windows / no shared structure
//
// Automation may SURFACE these; nothing here is executable without explicit
// per-venue risk checks and user approval.

import type {
  CrossVenueLink,
  CrossVenueMatchStatus,
  NormalizedMarket,
  RuleComparisonDimension,
} from "@/lib/types";
import { termOverlap } from "../signals/crossMarket";
import { parseCryptoThreshold } from "./threshold";
import { genId } from "@/lib/utils";

function dim(
  name: string,
  a: string | undefined,
  b: string | undefined,
  comparable: boolean,
  note: string,
): RuleComparisonDimension {
  return { name, a, b, comparable, note };
}

const HOURS = 3_600_000;

export function compareMarkets(
  a: NormalizedMarket,
  b: NormalizedMarket,
  now = Date.now(),
): CrossVenueLink | null {
  if (a.venueId === b.venueId) return null;
  const dims: RuleComparisonDimension[] = [];

  // ── event market vs spot product → reference link via threshold parse ────
  if (a.outcomeType !== b.outcomeType) {
    const event = a.outcomeType === "binary" ? a : b;
    const spot = a.outcomeType === "binary" ? b : a;
    const th = parseCryptoThreshold(event.question, event.endDate);
    if (!th || `cb:${th.coinbaseProduct}` !== spot.conditionId) return null;
    dims.push(
      dim("instrument_class", "event contract", "spot product", false,
        "Different instrument classes — spot is reference data for the event market, never a settlement equivalent."),
      dim("parsed_threshold", `${th.asset} ${th.direction} $${th.threshold.toLocaleString()}`, spot.venueMarketId, true,
        "Threshold parsed from the event title; spot product matches the asset."),
      dim("settlement", event.resolutionSource ?? "per event rules", "continuous market price", false,
        "Event settles per its resolution rules; spot has no settlement."),
    );
    return {
      id: genId("cvl"),
      sourceVenueId: event.venueId,
      sourceMarketId: event.conditionId,
      sourceTitle: event.question,
      targetVenueId: spot.venueId,
      targetMarketId: spot.conditionId,
      targetTitle: spot.question,
      matchStatus: "reference_only",
      matchScore: 0.9,
      dimensions: dims,
      updatedAt: now,
    };
  }

  // ── binary ↔ binary (Polymarket ↔ Kalshi) ────────────────────────────────
  const overlap = termOverlap(a.question, b.question);
  dims.push(
    dim("title_terms", a.question.slice(0, 70), b.question.slice(0, 70), overlap >= 0.5,
      `Key-term overlap ${(overlap * 100).toFixed(0)}% — titles alone NEVER establish equivalence.`),
  );
  if (overlap < 0.5) return null;

  // close-time window
  const aEnd = a.endDate ? new Date(a.endDate).getTime() : undefined;
  const bEnd = b.endDate ? new Date(b.endDate).getTime() : undefined;
  const windowDelta =
    aEnd !== undefined && bEnd !== undefined ? Math.abs(aEnd - bEnd) : undefined;
  const windowOk = windowDelta !== undefined && windowDelta <= 48 * HOURS;
  dims.push(
    dim("close_time", a.endDate, b.endDate, Boolean(windowOk),
      windowDelta === undefined
        ? "One side lacks a close time — settlement windows not comparable."
        : `Close times ${(windowDelta / HOURS).toFixed(1)}h apart (comparable ≤ 48h).`),
  );

  // structured thresholds, when parseable on both sides
  const thA = parseCryptoThreshold(a.question, a.endDate);
  const thB = parseCryptoThreshold(b.question, b.endDate);
  let thresholdState: "match" | "conflict" | "unknown" = "unknown";
  if (thA && thB) {
    const same =
      thA.asset === thB.asset &&
      thA.direction === thB.direction &&
      thA.kind === thB.kind &&
      Math.abs(thA.threshold - thB.threshold) / Math.max(thA.threshold, thB.threshold) < 0.001;
    thresholdState = same ? "match" : "conflict";
    dims.push(
      dim("threshold",
        `${thA.asset} ${thA.direction} $${thA.threshold.toLocaleString()} (${thA.kind})`,
        `${thB.asset} ${thB.direction} $${thB.threshold.toLocaleString()} (${thB.kind})`,
        same,
        same
          ? "Parsed thresholds match exactly (same level, direction and touch/terminal kind)."
          : "Parsed thresholds DISAGREE — these are different contracts. A touch (\"reach/hit\") and a terminal (\"above at close\") contract at the same level are NOT equivalent."),
    );
  }

  // resolution sources — comparable only when both state one
  const srcA = a.resolutionSource;
  const srcB = b.resolutionSource;
  const bothSources = Boolean(srcA && srcB);
  dims.push(
    dim("resolution_source", srcA, srcB, bothSources,
      bothSources
        ? "Both venues state a resolution source — verify wording manually before treating as related."
        : "Resolution source missing on at least one side — rules cannot be compared automatically."),
    dim("resolution_wording",
      a.description ? `${a.description.slice(0, 60)}…` : undefined,
      b.description ? `${b.description.slice(0, 60)}…` : undefined,
      false,
      "Automated wording equivalence is NOT attempted — human review required."),
    dim("venue_rules", "Polymarket UMA/negRisk rules", "Kalshi regulated settlement", false,
      "Different clearing/settlement regimes; fees, eligibility and limits differ."),
  );

  const category = (a.category ?? "").toLowerCase() === (b.category ?? "").toLowerCase();
  dims.push(dim("category", a.category, b.category, category, category ? "Same category." : "Categories differ."));

  // ── verdict ───────────────────────────────────────────────────────────────
  let status: CrossVenueMatchStatus;
  let score: number;
  if (thresholdState === "conflict") {
    status = "conflict";
    score = 0.3;
  } else if (!windowOk) {
    status = "not_comparable";
    score = 0.2;
  } else if (thresholdState === "match") {
    status = "strong_candidate"; // "exact" is reserved for human confirmation
    score = 0.85;
  } else if (overlap >= 0.7) {
    status = "weak_candidate";
    score = 0.5 + overlap * 0.2;
  } else {
    status = "weak_candidate";
    score = 0.4 + overlap * 0.2;
  }

  const divergence =
    a.yesPrice !== undefined && b.yesPrice !== undefined
      ? Number(Math.abs(a.yesPrice - b.yesPrice).toFixed(4))
      : undefined;

  return {
    id: genId("cvl"),
    sourceVenueId: a.venueId,
    sourceMarketId: a.conditionId,
    sourceTitle: a.question,
    targetVenueId: b.venueId,
    targetMarketId: b.conditionId,
    targetTitle: b.question,
    matchStatus: status,
    matchScore: Number(score.toFixed(2)),
    dimensions: dims,
    divergence,
    updatedAt: now,
  };
}

/**
 * Build cross-venue links across a merged market universe.
 * Prefilters by shared terms to stay off the O(n²) cliff, and links
 * crypto-threshold event markets to their Coinbase reference product.
 */
export function buildCrossVenueLinks(
  markets: NormalizedMarket[],
  now = Date.now(),
): CrossVenueLink[] {
  const links: CrossVenueLink[] = [];
  const pm = markets.filter((m) => m.venueId === "polymarket" && m.volume24h >= 5_000);
  const ks = markets.filter((m) => m.venueId === "kalshi");
  const cb = markets.filter((m) => m.venueId === "coinbase");

  // event ↔ spot reference links
  for (const m of [...pm, ...ks]) {
    for (const spot of cb) {
      const link = compareMarkets(m, spot, now);
      if (link) links.push(link);
    }
  }

  // Polymarket ↔ Kalshi candidates (term-prefiltered inside compareMarkets)
  for (const p of pm.slice(0, 400)) {
    for (const k of ks) {
      const link = compareMarkets(p, k, now);
      if (link) links.push(link);
    }
  }

  return links.sort((x, y) => y.matchScore - x.matchScore).slice(0, 200);
}
