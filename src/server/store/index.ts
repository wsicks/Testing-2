// Store selection: in-memory (default, zero setup) or Prisma/PostgreSQL when
// STORAGE_DRIVER=prisma and DATABASE_URL are configured.

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
      return await PrismaStore.create();
    } catch (err) {
      console.error(
        "[polyquant] failed to init Prisma store, falling back to memory:",
        err,
      );
    }
  }
  return new MemoryStore();
}

export type { Store } from "./types";
