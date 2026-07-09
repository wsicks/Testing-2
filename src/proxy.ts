import { NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/server/mutationGuard";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function proxy(req: NextRequest) {
  if (SAFE_METHODS.has(req.method)) return NextResponse.next();
  return requireMutationGuard(req) ?? NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
