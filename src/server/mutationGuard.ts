import { NextResponse } from "next/server";

const TOKEN_HEADER = "x-polyquant-mutation-token";

function bearerToken(value: string | null): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function requestHost(req: Request): string | undefined {
  const forwarded = req.headers.get("x-forwarded-host");
  if (forwarded) return forwarded.split(",")[0]?.trim();
  try {
    return new URL(req.url).host;
  } catch {
    return req.headers.get("host") ?? undefined;
  }
}

function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.split(":")[0]?.toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === requestHost(req);
  } catch {
    return false;
  }
}

function hasValidToken(req: Request): boolean {
  const expected = process.env.POLYQUANT_MUTATION_TOKEN;
  if (!expected) return false;
  const supplied =
    bearerToken(req.headers.get("authorization")) ??
    req.headers.get(TOKEN_HEADER) ??
    undefined;
  return supplied === expected;
}

/**
 * Guard state-changing API calls.
 *
 * Browser UI calls should be same-origin. Non-browser automation should send
 * POLYQUANT_MUTATION_TOKEN via `Authorization: Bearer ...` or
 * `x-polyquant-mutation-token`. Local no-origin calls remain available for
 * zero-config development against localhost.
 */
export function requireMutationGuard(req: Request): NextResponse | null {
  if (hasValidToken(req) || sameOrigin(req)) return null;

  const host = requestHost(req);
  const hasOrigin = Boolean(req.headers.get("origin"));
  if (!hasOrigin && isLocalHost(host) && process.env.NODE_ENV !== "production") {
    return null;
  }

  return NextResponse.json(
    {
      error:
        "mutation rejected: request must be same-origin or include a valid mutation token",
    },
    { status: 403 },
  );
}
