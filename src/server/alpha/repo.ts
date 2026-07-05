// Alpha Foundry persistence — typed repositories over the Store's KV layer.
//
// Follows the established runtime pattern (bandit state, autopilot registry):
// durable Prisma tables exist in the schema for these entities, but the
// running app reads/writes compact KV blobs so it behaves identically on the
// memory store and the Prisma store. Lists are capped so a runaway producer
// can't grow a blob without bound.

import type {
  AlphaFeature,
  AlphaOutcome,
  DisclosureRecord,
  ResearchIdea,
  SourceRecord,
  TrackedWalletRecord,
} from "@/lib/alpha/types";
import { getStore } from "../store";

const KEYS = {
  sources: "alpha:sources",
  wallets: "alpha:wallets",
  walletTrades: (id: string) => `alpha:walletTrades:${id}`,
  features: "alpha:features",
  outcomes: "alpha:outcomes",
  ideas: "alpha:ideas",
  disclosures: "alpha:disclosures",
  lastRuns: "alpha:lastRuns",
} as const;

const CAPS = {
  wallets: 300,
  walletTrades: 300,
  outcomes: 2_000,
  ideas: 120,
  disclosures: 240,
} as const;

export interface WalletTradeLite {
  side: "BUY" | "SELL";
  conditionId: string;
  asset: string;
  outcome?: string;
  outcomeIndex?: number;
  size: number;
  price: number;
  ts: number; // epoch ms
  title?: string;
  eventSlug?: string;
}

export interface AlphaLastRuns {
  intelAt?: number;
  discoveryAt?: number;
  scoringAt?: number;
  sourceHealthAt?: number;
  decayAt?: number;
  researchAt?: number;
  disclosuresAt?: number;
}

async function readList<T>(key: string): Promise<T[]> {
  const store = await getStore();
  return (await store.getKV<T[]>(key)) ?? [];
}

async function writeList<T>(key: string, rows: T[], cap?: number): Promise<void> {
  const store = await getStore();
  await store.setKV(key, cap !== undefined && rows.length > cap ? rows.slice(-cap) : rows);
}

// ── Sources ──────────────────────────────────────────────────────────────────

export const listSources = () => readList<SourceRecord>(KEYS.sources);
export const saveSources = (rows: SourceRecord[]) => writeList(KEYS.sources, rows);

export async function upsertSource(row: SourceRecord): Promise<void> {
  const rows = await listSources();
  const i = rows.findIndex((r) => r.sourceId === row.sourceId);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  await saveSources(rows);
}

// ── Wallets ──────────────────────────────────────────────────────────────────

export const listWallets = () => readList<TrackedWalletRecord>(KEYS.wallets);
export const saveWallets = (rows: TrackedWalletRecord[]) =>
  writeList(KEYS.wallets, rows, CAPS.wallets);

export async function upsertWallet(row: TrackedWalletRecord): Promise<void> {
  const rows = await listWallets();
  const i = rows.findIndex((r) => r.walletId === row.walletId);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  await saveWallets(rows);
}

export const getWalletTrades = (walletId: string) =>
  readList<WalletTradeLite>(KEYS.walletTrades(walletId));
export const saveWalletTrades = (walletId: string, rows: WalletTradeLite[]) =>
  writeList(KEYS.walletTrades(walletId), rows, CAPS.walletTrades);

// ── Features ─────────────────────────────────────────────────────────────────

export const listFeatures = () => readList<AlphaFeature>(KEYS.features);
export const saveFeatures = (rows: AlphaFeature[]) => writeList(KEYS.features, rows);

export async function upsertFeature(row: AlphaFeature): Promise<void> {
  const rows = await listFeatures();
  const i = rows.findIndex((r) => r.id === row.id);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  await saveFeatures(rows);
}

// ── Outcomes ─────────────────────────────────────────────────────────────────

export const listOutcomes = () => readList<AlphaOutcome>(KEYS.outcomes);
export const saveOutcomes = (rows: AlphaOutcome[]) =>
  writeList(KEYS.outcomes, rows, CAPS.outcomes);

// ── Ideas & disclosures ──────────────────────────────────────────────────────

export const listIdeas = () => readList<ResearchIdea>(KEYS.ideas);
export const saveIdeas = (rows: ResearchIdea[]) => writeList(KEYS.ideas, rows, CAPS.ideas);

export const listDisclosures = () => readList<DisclosureRecord>(KEYS.disclosures);
export const saveDisclosures = (rows: DisclosureRecord[]) =>
  writeList(KEYS.disclosures, rows, CAPS.disclosures);

// ── Run bookkeeping ──────────────────────────────────────────────────────────

export async function getLastRuns(): Promise<AlphaLastRuns> {
  const store = await getStore();
  return (await store.getKV<AlphaLastRuns>(KEYS.lastRuns)) ?? {};
}

export async function patchLastRuns(patch: Partial<AlphaLastRuns>): Promise<void> {
  const store = await getStore();
  const cur = (await store.getKV<AlphaLastRuns>(KEYS.lastRuns)) ?? {};
  await store.setKV(KEYS.lastRuns, { ...cur, ...patch });
}
