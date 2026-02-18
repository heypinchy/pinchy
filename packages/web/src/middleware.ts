import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  // Skip API routes and static files
  if (
    request.nextUrl.pathname.startsWith("/api") ||
    request.nextUrl.pathname.startsWith("/_next") ||
    request.nextUrl.pathname === "/setup"
  ) {
    return NextResponse.next();
  }

  // Check if setup is complete
  try {
    const res = await fetch(
      new URL("/api/setup/status", request.url)
    );
    const { setupComplete } = await res.json();

    if (!setupComplete) {
      return NextResponse.redirect(new URL("/setup", request.url));
    }
  } catch (error) {
    console.error("Setup status check failed:", error);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
