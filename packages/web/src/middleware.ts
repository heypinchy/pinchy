import { NextRequest, NextResponse } from "next/server";
import { getCachedDomain } from "@/lib/domain-cache";

const EXEMPT_PATHS = ["/api/health", "/api/setup/status"];

export function middleware(request: NextRequest): NextResponse {
  const lockedDomain = getCachedDomain();

  if (!lockedDomain) {
    return NextResponse.next();
  }

  const pathname = request.nextUrl.pathname;
  if (EXEMPT_PATHS.some((p) => pathname === p)) {
    return NextResponse.next();
  }

  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");

  if (host === lockedDomain) {
    return NextResponse.next();
  }

  return NextResponse.json(
    { error: "Forbidden: request host does not match the configured domain" },
    { status: 403 }
  );
}

export const config = {
  matcher: [
    // Match all paths except static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
