import { NextRequest, NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { autodiscover } from "@/lib/integrations/imap-autodiscover";

// audit-exempt: read-only best-effort autodiscovery, no state change
export const GET = withAdmin(async (request: NextRequest) => {
  const email = request.nextUrl.searchParams.get("email");

  if (!email) {
    return NextResponse.json({ config: {}, source: "none" });
  }

  try {
    const result = await autodiscover(email);
    return NextResponse.json(result);
  } catch {
    // autodiscover() is documented to never throw, but this is a
    // prefill-only, best-effort endpoint — defend against the
    // unexpected rather than surface a 500 for a non-critical lookup.
    return NextResponse.json({ config: {}, source: "none" });
  }
});
