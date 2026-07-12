import { NextResponse, type NextRequest } from "next/server";

/**
 * Server components (like the `(app)/layout.tsx` auth guard) have no direct
 * way to read the current request's path + query string. Proxy (Next's
 * successor to "middleware", same API) runs on every matched request and
 * does see it, so we stamp it onto a header that downstream server
 * components can read via `headers()`.
 *
 * This lets an expired-session redirect to `/login` carry a `returnTo` back
 * to wherever the user was headed — see `src/lib/return-to.ts` for the
 * open-redirect guard applied to that value before it's ever used.
 *
 * Any client-supplied `x-pathname` request header is overwritten below by
 * the value Next itself parsed from the request URL, so this cannot be used
 * to spoof the captured destination.
 */
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: [
    // Skip Next internals, API routes (which have their own auth checks),
    // and static assets — none of them need the returnTo redirect.
    "/((?!api|_next/static|_next/image|favicon.ico|sw.js).*)",
  ],
};
