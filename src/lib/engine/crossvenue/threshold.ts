// Crypto threshold parser: extracts "<ASSET> above/below $X by <date>"
// structure from event-market titles so crypto-linked prediction markets can
// be compared against Coinbase spot as REFERENCE data. Parsing is
// conservative — anything ambiguous returns null rather than a guess.

import type { CryptoThreshold } from "@/lib/types";

const ASSETS: { names: RegExp; asset: string; product: string }[] = [
  { names: /\b(btc|bitcoin)\b/i, asset: "BTC", product: "BTC-USD" },
  { names: /\b(eth|ethereum)\b/i, asset: "ETH", product: "ETH-USD" },
  { names: /\b(sol|solana)\b/i, asset: "SOL", product: "SOL-USD" },
  { names: /\b(xrp|ripple)\b/i, asset: "XRP", product: "XRP-USD" },
  { names: /\b(doge|dogecoin)\b/i, asset: "DOGE", product: "DOGE-USD" },
];

/** "$100,000", "$100k", "$1.5m", "100000 dollars" → USD number */
export function parseUsdAmount(text: string): number | null {
  const m =
    /\$\s*([\d,]+(?:\.\d+)?)\s*([km])?\b/i.exec(text) ??
    /\b([\d,]+(?:\.\d+)?)\s*([km])?\s*(?:usd|dollars)\b/i.exec(text);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const mult = m[2]?.toLowerCase() === "k" ? 1_000 : m[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
  return base * mult;
}

export function parseCryptoThreshold(
  title: string,
  endDate?: string,
): CryptoThreshold | null {
  const assetDef = ASSETS.find((a) => a.names.test(title));
  if (!assetDef) return null;

  const threshold = parseUsdAmount(title);
  if (threshold === null || threshold <= 0) return null;

  // direction words; ranges/ambiguous phrasing → not parseable
  const above = /\b(above|over|exceed|greater than|higher than|reach|hit|at least)\b/i.test(title);
  const below = /\b(below|under|less than|lower than|dip|fall under|drop below)\b/i.test(title);
  if (above === below) return null; // both or neither → ambiguous

  // sanity: threshold must be plausibly a price for the asset (rejects
  // "$5 fee" mentions inside unrelated titles)
  const plausible: Record<string, [number, number]> = {
    BTC: [1_000, 10_000_000],
    ETH: [50, 1_000_000],
    SOL: [1, 100_000],
    XRP: [0.01, 1_000],
    DOGE: [0.001, 100],
  };
  const [lo, hi] = plausible[assetDef.asset] ?? [0, Infinity];
  if (threshold < lo || threshold > hi) return null;

  return {
    asset: assetDef.asset,
    coinbaseProduct: assetDef.product,
    threshold,
    direction: above ? "above" : "below",
    byDate: endDate,
  };
}
