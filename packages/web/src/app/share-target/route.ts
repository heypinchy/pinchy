import { NextResponse } from "next/server";

// audit-exempt: SW-miss graceful fallback; drains the body but persists nothing and changes no state — only redirects the user to retry.
//
// This route only exists for the brief window right after a release where a
// device is still running the OLD no-op service worker until the new one
// (which intercepts `POST /share-target` client-side, see Tasks 3-4) has
// activated. In that window the share reaches the network instead of the SW.
// We cannot recover the shared file server-side here, so the goal is a clean
// redirect back to the share page rather than a bare 404 swallowing the
// share silently.
export async function POST(request: Request): Promise<Response> {
  try {
    await request.formData();
  } catch {
    // Best-effort drain only — nothing to recover or validate here.
  }

  return NextResponse.redirect(new URL("/share?error=retry", request.url), 303);
}
