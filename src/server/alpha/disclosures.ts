// DISCLOSURE RADAR — official public documents/events as DELAYED context.
//
// Live adapters (both keyless, public domain, verified):
//   Federal Register — rulemaking documents mapped to policy-linked markets
//   NWS active alerts — Severe/Extreme weather alerts mapped to weather
//     markets. This is the first Official Calendar Shock data slice: an
//     official source publishing state changes on its own schedule. It is
//     CONTEXT only — the calendar_shock trading feature stays in the
//     lifecycle (idea → data_connected once this feed proves stable) and
//     nothing trades from it.
//
// Congress.gov / Regulations.gov ship as registry entries that unlock with
// free API keys; House/Senate financial disclosures are marked
// manual_review because no permitted structured API exists (we do not
// scrape). Every record is context ONLY: humanReviewRequired is always
// true, publication lag is displayed, and nothing here generates a trade.

import type { DisclosureRecord } from "@/lib/alpha/types";
import { termOverlap } from "@/lib/engine/signals/crossMarket";
import { categorizeMarket } from "@/lib/alpha/score";
import { audit } from "../audit";
import { getMarkets } from "../marketData";
import { listDisclosures, listFeatures, saveDisclosures, upsertFeature } from "./repo";

const FEDREG_URL = "https://www.federalregister.gov/api/v1";

/** policy topics scanned each cycle — mapped to market categories */
const TOPICS: { term: string; tag: string }[] = [
  { term: "cryptocurrency", tag: "crypto" },
  { term: "tariff", tag: "macro" },
  { term: "artificial intelligence", tag: "ai_tech" },
  { term: "energy", tag: "macro" },
  { term: "drug pricing", tag: "politics" },
  { term: "election", tag: "elections" },
];

interface FedRegDoc {
  title: string;
  type: string;
  abstract?: string;
  document_number: string;
  html_url: string;
  publication_date: string;
  agencies?: { raw_name?: string; name?: string }[];
}

async function fetchTopic(term: string): Promise<FedRegDoc[]> {
  const url = `${FEDREG_URL}/documents.json?per_page=8&order=newest&conditions%5Bterm%5D=${encodeURIComponent(term)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { results?: FedRegDoc[] };
    return body.results ?? [];
  } finally {
    clearTimeout(timer);
  }
}

// ── NWS active severe alerts (Official Calendar Shock, slice 1) ─────────────

interface NwsAlert {
  id: string;
  properties: {
    event?: string;
    headline?: string;
    severity?: string;
    areaDesc?: string;
    effective?: string;
    senderName?: string;
  };
}

async function fetchNwsAlerts(): Promise<NwsAlert[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(
      "https://api.weather.gov/alerts/active?severity=Severe,Extreme&message_type=alert",
      {
        signal: ctrl.signal,
        headers: {
          accept: "application/geo+json",
          "user-agent": "eventquant-terminal (calendar-shock research)",
        },
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { features?: NwsAlert[] };
    return body.features ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/** first successful NWS ingest moves calendar_shock idea → data_connected */
async function markCalendarShockConnected(): Promise<void> {
  const features = await listFeatures();
  const f = features.find((x) => x.id === "calendar_shock");
  if (!f || f.status !== "idea") return;
  f.status = "data_connected";
  f.updatedAt = Date.now();
  await upsertFeature(f);
  await audit("scanner", "alpha_feature_data_connected", "calendar_shock: NWS severe-alert feed verified and ingesting — feature advances idea → data_connected (backtest + paper testing still ahead)", {});
}

export async function refreshDisclosures(): Promise<number> {
  const existing = await listDisclosures();
  const seen = new Set(existing.map((d) => d.id));
  const now = Date.now();

  let markets: Awaited<ReturnType<typeof getMarkets>>["markets"] = [];
  try {
    markets = (await getMarkets()).markets.filter(
      (m) => m.venueId !== "coinbase" && !m.referenceOnly,
    );
  } catch {
    /* mapping degrades gracefully to zero related markets */
  }

  const fresh: DisclosureRecord[] = [];
  for (const topic of TOPICS) {
    try {
      const docs = await fetchTopic(topic.term);
      for (const doc of docs) {
        const id = `fedreg:${doc.document_number}`;
        if (seen.has(id)) continue;
        const related = markets
          .map((m) => ({
            conditionId: m.conditionId,
            question: m.question,
            overlap: termOverlap(doc.title, m.question),
          }))
          .filter((r) => r.overlap >= 0.2)
          .sort((a, b) => b.overlap - a.overlap)
          .slice(0, 3);
        const pubMs = new Date(doc.publication_date).getTime();
        fresh.push({
          id,
          source: "federal_register",
          docType: doc.type,
          title: doc.title,
          url: doc.html_url,
          filingDate: doc.publication_date,
          lagDays: Number(((now - pubMs) / 86_400_000).toFixed(1)),
          agency: doc.agencies?.[0]?.raw_name ?? doc.agencies?.[0]?.name,
          policyTags: [topic.tag, topic.term],
          relatedMarkets: related,
          confidence: related.length ? Math.min(0.7, related[0].overlap) : 0.1,
          humanReviewRequired: true,
          fetchedAt: now,
        });
        seen.add(id);
      }
    } catch {
      /* one topic failing must not kill the sweep */
    }
  }
  // NWS severe/extreme alerts → weather-market context (calendar shock #1)
  let nwsAdded = 0;
  try {
    const alerts = await fetchNwsAlerts();
    const weatherMarkets = markets.filter(
      (m) => categorizeMarket({ question: m.question, category: m.category, tags: m.tags }) === "weather",
    );
    for (const a of alerts.slice(0, 20)) {
      const p = a.properties;
      const id = `nws:${a.id.split("/").pop() ?? a.id}`;
      if (seen.has(id) || !p.event) continue;
      const hay = `${p.event} ${p.areaDesc ?? ""}`;
      const related = weatherMarkets
        .map((m) => ({ conditionId: m.conditionId, question: m.question, overlap: termOverlap(hay, m.question) }))
        .filter((r) => r.overlap >= 0.15)
        .sort((a2, b) => b.overlap - a2.overlap)
        .slice(0, 3);
      const effMs = p.effective ? new Date(p.effective).getTime() : now;
      fresh.push({
        id,
        source: "nws",
        docType: p.event,
        title: p.headline ?? `${p.severity ?? ""} ${p.event} — ${p.areaDesc?.slice(0, 80) ?? ""}`,
        url: a.id,
        filingDate: p.effective ?? new Date(now).toISOString(),
        lagDays: Number(((now - effMs) / 86_400_000).toFixed(2)),
        agency: p.senderName ?? "National Weather Service",
        policyTags: ["weather", (p.severity ?? "severe").toLowerCase()],
        relatedMarkets: related,
        confidence: related.length ? Math.min(0.7, related[0].overlap) : 0.1,
        humanReviewRequired: true,
        fetchedAt: now,
      });
      seen.add(id);
      nwsAdded += 1;
    }
    if (nwsAdded > 0 || alerts.length > 0) await markCalendarShockConnected();
  } catch {
    /* NWS outage must not kill the Federal Register sweep results */
  }

  if (fresh.length) {
    // re-read before write-back: the sweep above spans many seconds of
    // network I/O and a concurrent writer (attention spikes, a second sweep)
    // must not be erased by this call's pre-sweep snapshot
    const latest = await listDisclosures();
    const latestIds = new Set(latest.map((d) => d.id));
    await saveDisclosures([...latest, ...fresh.filter((d) => !latestIds.has(d.id))]);
    await audit(
      "scanner",
      "disclosures_refreshed",
      `Disclosure Radar: ${fresh.length} new record(s) — ${fresh.length - nwsAdded} Federal Register, ${nwsAdded} NWS severe-alert (context only — human review required)`,
      {},
    );
  }
  return fresh.length;
}

export { listDisclosures };
