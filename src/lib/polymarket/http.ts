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

export async function getJson<T>(
  url: string,
  opts: HttpOpts = {},
): Promise<T> {
  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
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
