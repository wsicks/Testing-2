// TTL cache with in-flight request de-duplication. In-memory by default;
// transparently mirrors through Redis when REDIS_URL is configured so several
// processes (web + worker) share one upstream request budget.

import { incr } from "./perf";

type Entry = { value: unknown; exp: number };

interface CacheGlobal {
  map: Map<string, Entry>;
  inflight: Map<string, Promise<unknown>>;
  redis?: import("ioredis").Redis | null;
}

const g = globalThis as unknown as { __pqCache?: CacheGlobal };

function state(): CacheGlobal {
  if (!g.__pqCache) {
    g.__pqCache = { map: new Map(), inflight: new Map(), redis: undefined };
  }
  return g.__pqCache;
}

async function getRedis(): Promise<import("ioredis").Redis | null> {
  const s = state();
  if (s.redis !== undefined) return s.redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    s.redis = null;
    return null;
  }
  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    await client.connect();
    s.redis = client;
  } catch {
    s.redis = null;
  }
  return s.redis;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const s = state();
  const e = s.map.get(key);
  if (e && e.exp > Date.now()) {
    incr("cache.hit");
    return e.value as T;
  }
  incr("cache.miss");
  s.map.delete(key);
  const redis = await getRedis();
  if (redis) {
    try {
      const v = await redis.get(`pq:${key}`);
      if (v !== null) return JSON.parse(v) as T;
    } catch {
      /* redis miss is non-fatal */
    }
  }
  return undefined;
}

export async function cacheSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const s = state();
  s.map.set(key, { value, exp: Date.now() + ttlMs });
  if (s.map.size > 2000) {
    // opportunistic eviction of expired entries
    const now = Date.now();
    for (const [k, e] of s.map) if (e.exp <= now) s.map.delete(k);
  }
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(`pq:${key}`, JSON.stringify(value), "PX", ttlMs);
    } catch {
      /* non-fatal */
    }
  }
}

/** memoize an async producer under a TTL with in-flight dedupe */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const s = state();
  const existing = s.inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    try {
      const v = await fn();
      await cacheSet(key, v, ttlMs);
      return v;
    } finally {
      s.inflight.delete(key);
    }
  })();
  s.inflight.set(key, p);
  return p;
}
