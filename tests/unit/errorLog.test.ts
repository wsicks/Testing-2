import { beforeEach, describe, expect, it } from "vitest";
import { errorLogStats, listErrors, logError, resolveError } from "@/server/errorLog";

// the module keeps state on globalThis — reset between tests
beforeEach(() => {
  (globalThis as Record<string, unknown>).__eqErrLog = undefined;
});

describe("runtime error log", () => {
  it("dedupes repeats of the same (source, message) into one counted row", async () => {
    logError("scanner:tick", new Error("fetch failed"));
    logError("scanner:tick", new Error("fetch failed"));
    logError("scanner:tick", new Error("fetch failed"), "third time detail");
    const rows = await listErrors();
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
    expect(rows[0].detail).toBe("third time detail");
    expect(rows[0].resolved).toBe(false);
  });

  it("keeps different sources/messages as separate rows", async () => {
    logError("scanner:tick", new Error("fetch failed"));
    logError("foundry:attention", new Error("fetch failed"));
    logError("scanner:tick", "another message");
    expect(await listErrors()).toHaveLength(3);
  });

  it("resolve marks a row; recurrence reopens it", async () => {
    logError("autopilot:tick", new Error("boom"));
    const [row] = await listErrors();
    expect(await resolveError(row.id)).toBe(true);
    expect((await errorLogStats()).open).toBe(0);
    logError("autopilot:tick", new Error("boom"));
    expect((await errorLogStats()).open).toBe(1);
    expect((await listErrors())[0].count).toBe(2);
  });

  it("never throws, even on hostile input", async () => {
    expect(() => logError("x", { weird: true })).not.toThrow();
    expect(() => logError("x", undefined)).not.toThrow();
    const rows = await listErrors();
    expect(rows.length).toBeGreaterThan(0);
  });
});
