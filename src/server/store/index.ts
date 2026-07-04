// Store selection: in-memory (default, zero setup) or Prisma/PostgreSQL when
// STORAGE_DRIVER=prisma and DATABASE_URL are configured.

import type { AppSettings } from "@/lib/types";
import type { Store } from "./types";
import { MemoryStore } from "./memory";

const g = globalThis as unknown as { __pqStore?: Promise<Store> };

export function getStore(): Promise<Store> {
  if (!g.__pqStore) {
    g.__pqStore = create();
  }
  return g.__pqStore;
}

async function create(): Promise<Store> {
  if (
    process.env.STORAGE_DRIVER === "prisma" &&
    process.env.DATABASE_URL
  ) {
    try {
      const { PrismaStore } = await import("./prisma");
      return withSettingsCache(await PrismaStore.create());
    } catch (err) {
      console.error(
        "[polyquant] failed to init Prisma store, falling back to memory:",
        err,
      );
    }
  }
  return withSettingsCache(new MemoryStore());
}

/**
 * Hot-path settings cache: getSettings() is called on every preview/risk
 * check, so serve it from memory (3s TTL) and update the cache immediately on
 * writes. Keeps the DB out of the order-preview path under the prisma driver.
 * Implemented as a Proxy so class-instance stores keep their prototype
 * methods (a plain object spread would silently drop them).
 */
function withSettingsCache(store: Store): Store {
  let cached: { value: AppSettings; ts: number } | null = null;
  const TTL = 3_000;
  const overrides: Pick<Store, "getSettings" | "patchSettings"> = {
    async getSettings() {
      if (cached && Date.now() - cached.ts < TTL) return cached.value;
      const value = await store.getSettings();
      cached = { value, ts: Date.now() };
      return value;
    },
    async patchSettings(patch) {
      const value = await store.patchSettings(patch);
      cached = { value, ts: Date.now() };
      return value;
    },
  };
  return new Proxy(store, {
    get(target, prop, _receiver) {
      if (prop === "getSettings" || prop === "patchSettings") {
        return overrides[prop];
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export type { Store } from "./types";
