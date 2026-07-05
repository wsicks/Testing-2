// DISCLOSURE RADAR — official public documents as DELAYED context.
//
// Live adapter: Federal Register API (keyless, public domain, verified).
// Congress.gov / Regulations.gov ship as registry entries that unlock with
// free API keys; House/Senate financial disclosures are marked
// manual_review because no permitted structured API exists (we do not
// scrape). Every record is context ONLY: humanReviewRequired is always
// true, filing lag is displayed, and nothing here generates a trade.

import type { DisclosureRecord } from "@/lib/alpha/types";
import { termOverlap } from "@/lib/engine/signals/crossMarket";
import { audit } from "../audit";
import { getMarkets } from "../marketData";
import { listDisclosures, saveDisclosures } from "./repo";

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
  if (fresh.length) {
    await saveDisclosures([...existing, ...fresh]);
    await audit(
      "scanner",
      "disclosures_refreshed",
      `Disclosure Radar: ${fresh.length} new Federal Register document(s) mapped (context only — human review required)`,
      {},
    );
  }
  return fresh.length;
}

export { listDisclosures };
