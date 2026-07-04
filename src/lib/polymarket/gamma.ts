// Gamma market-discovery API adapter.
// Docs: https://docs.polymarket.com — Gamma API (market discovery / metadata).

import { GAMMA_API_URL, NEW_MARKET_HOURS, CATEGORY_FALLBACK } from "../constants";
import type { NormalizedMarket } from "../types";
import { getJson, qs, type HttpOpts } from "./http";

// Raw (partial) shapes as returned by Gamma. Fields verified against the live
// production API — see README "Data sources".
export interface GammaTag {
  id: string;
  label: string;
  slug: string;
}

export interface GammaMarketRaw {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  description?: string;
  endDate?: string;
  startDate?: string;
  createdAt?: string;
  category?: string;
  active: boolean;
  closed: boolean;
  negRisk?: boolean;
  archived?: boolean;
  enableOrderBook?: boolean;
  acceptingOrders?: boolean;
  liquidityNum?: number;
  volumeNum?: number;
  volume24hr?: number;
  outcomes?: string; // JSON-encoded string array
  outcomePrices?: string; // JSON-encoded string array
  clobTokenIds?: string; // JSON-encoded string array
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  oneDayPriceChange?: number;
  oneHourPriceChange?: number;
  groupItemTitle?: string;
  new?: boolean;
}

export interface GammaEventRaw {
  id: string;
  title: string;
  slug: string;
  active: boolean;
  closed: boolean;
  endDate?: string;
  negRisk?: boolean;
  volume24hr?: number;
  liquidity?: number;
  tags?: GammaTag[];
  markets: GammaMarketRaw[];
}

function parseJsonArray(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Tags that describe UI behavior rather than content — excluded from category. */
const META_TAGS = new Set([
  "hide from new",
  "recurring",
  "tournament futures",
  "all",
]);

export function pickCategory(tags: GammaTag[] | undefined): string {
  if (!tags?.length) return CATEGORY_FALLBACK;
  const t = tags.find((x) => !META_TAGS.has(x.label.toLowerCase()));
  return t?.label ?? CATEGORY_FALLBACK;
}

export function normalizeGammaMarket(
  m: GammaMarketRaw,
  event: Pick<GammaEventRaw, "title" | "slug" | "tags"> | undefined,
  now = Date.now(),
): NormalizedMarket | null {
  if (!m.conditionId || !m.question) return null;
  const outcomes = parseJsonArray(m.outcomes);
  const prices = parseJsonArray(m.outcomePrices).map(Number);
  const tokenIds = parseJsonArray(m.clobTokenIds);
  const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
  const yi = yesIdx >= 0 ? yesIdx : 0;
  const ni = yi === 0 ? 1 : 0;
  const yesPrice = Number.isFinite(prices[yi]) ? prices[yi] : undefined;
  const noPrice = Number.isFinite(prices[ni]) ? prices[ni] : undefined;
  const bestBid = m.bestBid ?? undefined;
  const bestAsk = m.bestAsk ?? undefined;
  const midpoint =
    bestBid !== undefined && bestAsk !== undefined
      ? (bestBid + bestAsk) / 2
      : yesPrice;
  const created = m.createdAt ? new Date(m.createdAt).getTime() : undefined;
  const tags = (event?.tags ?? []).map((t) => t.label);

  return {
    conditionId: m.conditionId,
    gammaId: m.id,
    slug: m.slug,
    eventSlug: event?.slug,
    question: m.question,
    eventTitle: event?.title,
    description: m.description,
    category: m.category || pickCategory(event?.tags),
    tags,
    endDate: m.endDate,
    startDate: m.startDate,
    active: m.active,
    closed: m.closed,
    negRisk: Boolean(m.negRisk),
    liquidity: m.liquidityNum ?? 0,
    volume24h: m.volume24hr ?? 0,
    volumeTotal: m.volumeNum ?? 0,
    outcomes: outcomes.map((label, i) => ({
      tokenId: tokenIds[i] ?? "",
      label,
      price: Number.isFinite(prices[i]) ? prices[i] : undefined,
    })),
    yesTokenId: tokenIds[yi],
    noTokenId: tokenIds[ni],
    yesPrice,
    noPrice,
    bestBid,
    bestAsk,
    spread: m.spread ?? (bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined),
    midpoint,
    oneDayPriceChange: m.oneDayPriceChange,
    oneHourPriceChange: m.oneHourPriceChange,
    isNew:
      m.new ||
      (created !== undefined && now - created < NEW_MARKET_HOURS * 3_600_000),
    source: "gamma",
    fetchedAt: now,
  };
}

/**
 * Fetch active events with nested markets from Gamma and flatten into
 * normalized market rows. One request covers titles, tags, prices, liquidity,
 * volume, best bid/ask and spread.
 */
export async function fetchActiveMarkets(
  params: { limit?: number; tagSlug?: string; order?: string } = {},
  opts: HttpOpts = {},
): Promise<NormalizedMarket[]> {
  const url =
    `${GAMMA_API_URL}/events` +
    qs({
      active: true,
      closed: false,
      archived: false,
      limit: params.limit ?? 100,
      order: params.order ?? "volume24hr",
      ascending: false,
      tag_slug: params.tagSlug,
    });
  const events = await getJson<GammaEventRaw[]>(url, opts);
  const now = Date.now();
  const rows: NormalizedMarket[] = [];
  for (const ev of events) {
    for (const m of ev.markets ?? []) {
      if (m.archived || m.enableOrderBook === false) continue;
      const norm = normalizeGammaMarket(m, ev, now);
      if (norm && norm.active && !norm.closed && norm.yesTokenId) rows.push(norm);
    }
  }
  return rows;
}

