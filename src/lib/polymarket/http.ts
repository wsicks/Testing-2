// Shared HTTP plumbing for Polymarket API adapters.
// fetchFn is injectable so integration tests can run fully offline.

export type FetchFn = typeof fetch;

export class PolymarketApiError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PolymarketApiError";
  }
}

export interface HttpOpts {
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

/**
 * Optional latency hook — the server registers a recorder so EXTERNAL
 * Polymarket API round-trips show up in the perf panel under `upstream.*`.
 * These are external-infrastructure timings and carry no <20ms promise.
 */
let latencyHook: ((label: string, ms: number) => void) | null = null;
export function setUpstreamLatencyHook(fn: (label: string, ms: number) => void): void {
  latencyHook = fn;
}

function upstreamLabel(url: string): string {
  if (url.includes("gamma-api")) return "upstream.gamma";
  if (url.includes("clob.")) return "upstream.clob";
  if (url.includes("data-api")) return "upstream.data";
  if (url.includes("kalshi")) return "upstream.kalshi";
  if (url.includes("coinbase")) return "upstream.coinbase";
  if (url.includes("coingecko")) return "upstream.coingecko";
  return "upstream.other";
}

export async function getJson<T>(
  url: string,
  opts: HttpOpts = {},
): Promise<T> {
  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  const t0 = Date.now();
  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new PolymarketApiError(
        `HTTP ${res.status} from ${url}`,
        url,
        res.status,
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof PolymarketApiError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolymarketApiError(`Request failed: ${msg}`, url);
  } finally {
    clearTimeout(timer);
    latencyHook?.(upstreamLabel(url), Date.now() - t0);
  }
}

/** POST + JSON body variant of getJson — same timeout/error/latency plumbing */
export async function postJson<T>(
  url: string,
  body: unknown,
  opts: HttpOpts = {},
): Promise<T> {
  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  const t0 = Date.now();
  try {
    const res = await fetchFn(url, {
      method: "POST",
      signal: controller.signal,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new PolymarketApiError(`HTTP ${res.status} from ${url}`, url, res.status);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof PolymarketApiError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolymarketApiError(`Request failed: ${msg}`, url);
  } finally {
    clearTimeout(timer);
    latencyHook?.(upstreamLabel(url), Date.now() - t0);
  }
}

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
