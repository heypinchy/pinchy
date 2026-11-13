// audit-exempt: read-only credential test, no state changes
import { NextResponse } from "next/server";
import { OdooClient } from "odoo-node";
import { withAdmin } from "@/lib/api-auth";
import { resolveExternalUrlTarget } from "@/lib/integrations/url-validation";
import { withPinnedOdooFetch } from "@/lib/integrations/odoo-pin";
import { parseRequestBody } from "@/lib/api-validation";
import { testCredentialsSchema } from "@/lib/schemas/integrations";
import { describeOdooError } from "@/lib/integrations/odoo-error";
import { authenticateOdoo, readOdooVersion } from "@/lib/integrations/odoo-calls";

export const POST = withAdmin(async (request) => {
  const parsed = await parseRequestBody(testCredentialsSchema, request);
  if ("error" in parsed) return parsed.error;

  if (parsed.data.type === "web-search") {
    try {
      const res = await fetch("https://api.search.brave.com/res/v1/web/search?q=test&count=1", {
        headers: { "X-Subscription-Token": parsed.data.credentials.apiKey },
      });
      if (!res.ok) {
        return NextResponse.json({ success: false, error: "Invalid API key" });
      }
      return NextResponse.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection failed";
      return NextResponse.json({ success: false, error: message });
    }
  }

  const { credentials } = parsed.data;

  // Resolve once and connect to that answer: checking the URL and then letting
  // odoo-node fetch it by name resolved twice (DNS rebinding).
  const urlCheck = await resolveExternalUrlTarget(credentials.url);
  if (!urlCheck.valid) {
    return NextResponse.json({ error: urlCheck.error }, { status: urlCheck.transient ? 503 : 400 });
  }

  return withPinnedOdooFetch(urlCheck.url, urlCheck.target, async () => {
    try {
      const url = credentials.url.trim();
      const db = credentials.db.trim();
      const login = credentials.login.trim();
      const apiKey = credentials.apiKey.trim();

      const uid = await authenticateOdoo({ url, db, login, apiKey });

      const client = new OdooClient({
        url,
        db,
        uid,
        apiKey,
      });
      const version = await readOdooVersion(client);

      return NextResponse.json({
        success: true,
        version: version.serverVersion,
        uid,
      });
    } catch (error) {
      return NextResponse.json({ success: false, error: describeOdooError(error) });
    }
  });
});
