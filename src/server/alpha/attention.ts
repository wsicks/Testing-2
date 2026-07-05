// ATTENTION IMBALANCE (Feature Forge #5) — slice 1: GDELT news-volume
// spikes as CONTEXT records.
//
// GDELT's doc API gives topic-level volume intensity in 15-minute buckets
// (validated live). Topic-level is the honest granularity: we do NOT
// pretend aggregate news volume maps to a single market, so spikes enter
// the Disclosure Radar context feed (human review, never a trade) mapped
// to candidate markets by term overlap. The imbalance half of the thesis —
// attention spiking while a related market does NOT move — is what the
// spike record lets a human (or a later, evidence-gated feature) check.
//
// Rate limit: GDELT documents 1 request / 5 seconds, but in practice
// shared-egress IPs sit in much longer cooldowns (observed live). So this
// adapter is maximally polite: ONE topic per 6-hour cycle, rotating through
// the topic set (full coverage ≈ 30h), throttle responses fail closed and
// are never retried within a cycle. The attention_imbalance feature only
// advances past `idea` when ingestion actually succeeds.

import type { DisclosureRecord } from "@/lib/alpha/types";
import { termOverlap } from "@/lib/engine/signals/crossMarket";
import { audit } from "../audit";
import { getMarkets } from "../marketData";
import {
  listDisclosures,
  listFeatures,
  listSources,
  saveDisclosures,
  saveSources,
  upsertFeature,
} from "./repo";
import { getStore } from "../store";

const GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const KV_ATTENTION = "alpha:attention";

/** small fixed topic set — each fetch costs a rate-limit slot */
const TOPICS: { query: string; label: string; category: string }[] = [
  { query: '"bitcoin"', label: "bitcoin", category: "crypto" },
  { query: '"federal reserve" "interest rate"', label: "fed rates", category: "fed_rates" },
  { query: '"tariff"', label: "tariffs", category: "macro" },
  { query: '"election"', label: "elections", category: "elections" },
  { query: '"ceasefire"', label: "geopolitics", category: "geopolitics" },
];

export interface AttentionTopic {
  label: string;
  category: string;
  /** latest 2h mean volume intensity */
  recent: number;
  /** baseline mean over the prior window */
  baseline: number;
  /** (recent − baseline) / std of the baseline window */
  zScore: number;
  points: number;
  fetchedAt: number;
}

interface TimelinePoint {
  date: string;
  value: number;
}

async function fetchTimeline(query: string): Promise<TimelinePoint[]> {
  const url = `${GDELT_URL}?query=${encodeURIComponent(query)}&mode=timelinevol&format=json&timespan=3d`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "eventquant-terminal (attention research)" },
    });
    const text = await res.text();
    // a throttle reply is plain text, not JSON — surface it as a failure
    const body = JSON.parse(text) as { timeline?: { data?: TimelinePoint[] }[] };
    return body.timeline?.[0]?.data ?? [];
  } finally {
    clearTimeout(timer);
  }
}

function summarize(label: string, category: string, pts: TimelinePoint[], now: number): AttentionTopic | null {
  if (pts.length < 24) return null;
  // 15-min buckets: recent = last 8 (2h), baseline = everything before
  const values = pts.map((p) => p.value);
  const recent = values.slice(-8);
  const base = values.slice(0, -8);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const bMean = mean(base);
  const bStd = Math.sqrt(mean(base.map((x) => (x - bMean) ** 2))) || 1e-6;
  const rMean = mean(recent);
  return {
    label,
    category,
    recent: Number(rMean.toFixed(4)),
    baseline: Number(bMean.toFixed(4)),
    zScore: Number(((rMean - bMean) / bStd).toFixed(2)),
    points: pts.length,
    fetchedAt: now,
  };
}

async function recordSourceOutcome(ok: boolean, error?: string): Promise<void> {
  const sources = await listSources();
  const s = sources.find((x) => x.sourceId === "gdelt");
  if (!s) return;
  if (ok) {
    s.lastSuccessfulCall = Date.now();
    s.reliabilityScore = Math.min(1, s.reliabilityScore * 0.9 + 0.1);
    if (s.status === "disabled" || s.status === "degraded") s.status = "active";
    s.note = "attention-imbalance feed live — topic-level volume, 1 req/5s respected";
  } else {
    s.lastFailedCall = Date.now();
    s.lastError = error?.slice(0, 120);
    s.reliabilityScore = Math.max(0, s.reliabilityScore * 0.9);
    if (s.status === "active") s.status = "degraded";
  }
  await saveSources(sources);
}

const KV_ATTENTION_CURSOR = "alpha:attentionCursor";

export async function refreshAttention(): Promise<{ topics: number; spikes: number }> {
  const now = Date.now();
  const store = await getStore();

  // one topic per cycle, rotating — a single request per 6h window
  const cursor = ((await store.getKV<number>(KV_ATTENTION_CURSOR)) ?? 0) % TOPICS.length;
  const topic = TOPICS[cursor];
  await store.setKV(KV_ATTENTION_CURSOR, cursor + 1);

  let fresh: AttentionTopic | null = null;
  let failed: string | undefined;
  try {
    const pts = await fetchTimeline(topic.query);
    fresh = summarize(topic.label, topic.category, pts, now);
    if (!fresh) failed = `timeline too short (${pts.length} points)`;
  } catch (e) {
    failed = String(e).slice(0, 120); // throttle/parse — fail closed, no retry
  }
  await recordSourceOutcome(fresh !== null, failed);
  if (!fresh) return { topics: 0, spikes: 0 };

  // merge into the stored topic set; entries older than 48h age out
  const prior = ((await store.getKV<AttentionTopic[]>(KV_ATTENTION)) ?? []).filter(
    (t) => t.label !== fresh!.label && now - t.fetchedAt < 48 * 3_600_000,
  );
  const results = [...prior, fresh];
  await store.setKV(KV_ATTENTION, results);

  // spikes (z ≥ 2) become context records — but ONLY from the topic measured
  // THIS cycle. Prior topics are up to 48h stale; re-emitting them each 6h
  // window would mint "fresh" spike records from old measurements.
  const spikes = [fresh].filter((t) => t.zScore >= 2);
  let added = 0;
  if (spikes.length > 0) {
    const existing = await listDisclosures();
    const seen = new Set(existing.map((d) => d.id));
    let markets: Awaited<ReturnType<typeof getMarkets>>["markets"] = [];
    try {
      markets = (await getMarkets()).markets.filter((m) => !m.referenceOnly);
    } catch {
      /* mapping degrades to zero related markets */
    }
    const fresh: DisclosureRecord[] = [];
    for (const t of spikes) {
      // one record per topic per 6h window
      const id = `gdelt:${t.label}:${Math.floor(now / (6 * 3_600_000))}`;
      if (seen.has(id)) continue;
      const related = markets
        .map((m) => ({ conditionId: m.conditionId, question: m.question, overlap: termOverlap(t.label, m.question) }))
        .filter((r) => r.overlap >= 0.15)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, 3);
      fresh.push({
        id,
        source: "gdelt",
        docType: "attention_spike",
        title: `News attention spike: "${t.label}" volume ${t.zScore.toFixed(1)}σ above its 3-day baseline`,
        url: `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(t.label)}&mode=timelinevol`,
        filingDate: new Date(now).toISOString(),
        lagDays: 0,
        agency: "GDELT (aggregated news metadata — reference only)",
        policyTags: [t.category, "attention"],
        relatedMarkets: related,
        confidence: Math.min(0.5, related.length ? related[0].overlap : 0.1),
        humanReviewRequired: true,
        fetchedAt: now,
      });
      seen.add(id);
      added += 1;
    }
    if (fresh.length) {
      await saveDisclosures([...(await listDisclosures()), ...fresh]);
    }
  }

  // first successful ingest advances the feature through the lifecycle
  const features = await listFeatures();
  const f = features.find((x) => x.id === "attention_imbalance");
  if (f && f.status === "idea") {
    f.status = "data_connected";
    f.updatedAt = now;
    await upsertFeature(f);
    await audit("scanner", "alpha_feature_data_connected", "attention_imbalance: GDELT volume feed validated and ingesting (topic-level, reference-only) — idea → data_connected", {});
  }
  if (added > 0) {
    await audit("scanner", "attention_spikes", `Attention: ${added} topic spike(s) recorded as context (z ≥ 2 vs 3-day baseline)`, {});
  }
  return { topics: results.length, spikes: added };
}

export async function getAttention(): Promise<AttentionTopic[]> {
  const store = await getStore();
  return (await store.getKV<AttentionTopic[]>(KV_ATTENTION)) ?? [];
}
