import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const OLD_TOKEN = process.env.POLYQUANT_MUTATION_TOKEN;

function req(
  method: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("https://terminal.example/api/killswitch", {
    method,
    headers,
  });
}

describe("API mutation guard middleware", () => {
  afterEach(() => {
    if (OLD_TOKEN === undefined) delete process.env.POLYQUANT_MUTATION_TOKEN;
    else process.env.POLYQUANT_MUTATION_TOKEN = OLD_TOKEN;
  });

  it("allows safe methods without mutation checks", () => {
    const res = proxy(req("GET", { origin: "https://evil.example" }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("blocks cross-origin mutating requests", async () => {
    const res = proxy(req("POST", { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("same-origin"),
    });
  });

  it("allows same-origin mutating requests", () => {
    const res = proxy(req("POST", { origin: "https://terminal.example" }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("allows token-authenticated automation requests", () => {
    process.env.POLYQUANT_MUTATION_TOKEN = "secret";
    const res = proxy(
      req("POST", {
        origin: "https://evil.example",
        authorization: "Bearer secret",
      }),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
