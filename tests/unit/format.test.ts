import { describe, expect, it } from "vitest";
import { fmtCents, fmtSignedUsd, fmtTimeUntil, fmtUsd } from "@/lib/format";

describe("fmtUsd", () => {
  it("formats positives across magnitude breaks", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(1234.5)).toBe("$1,234.50");
    expect(fmtUsd(15_000)).toBe("$15.0K");
    expect(fmtUsd(2_500_000)).toBe("$2.50M");
  });

  it("keeps the sign in front of the currency symbol for negatives", () => {
    expect(fmtUsd(-15_000)).toBe("-$15.0K");
    expect(fmtUsd(-2_500_000)).toBe("-$2.50M");
    expect(fmtUsd(-3.5)).toBe("-$3.50");
  });

  it("handles null/undefined/NaN", () => {
    expect(fmtUsd(undefined)).toBe("—");
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(Number.NaN)).toBe("—");
  });
});

describe("fmtSignedUsd", () => {
  it("prefixes explicit +/− and stays consistent with fmtUsd", () => {
    expect(fmtSignedUsd(15_000)).toBe("+$15.0K");
    expect(fmtSignedUsd(-15_000)).toBe("-$15.0K");
    expect(fmtSignedUsd(0)).toBe("$0.00");
  });
});

describe("misc formatters", () => {
  it("fmtCents renders price units", () => {
    expect(fmtCents(0.515)).toBe("51.5¢");
    expect(fmtCents(undefined)).toBe("—");
  });

  it("fmtTimeUntil reports closed for past dates", () => {
    expect(fmtTimeUntil(new Date(Date.now() - 1000).toISOString())).toBe("closed");
    expect(fmtTimeUntil(undefined)).toBe("—");
  });
});
