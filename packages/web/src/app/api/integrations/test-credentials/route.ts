// audit-exempt: read-only credential test, no state changes
import { NextResponse } from "next/server";
import { z } from "zod";
import { OdooClient } from "odoo-node";
import { withAdmin } from "@/lib/api-auth";
import { validateExternalUrl } from "@/lib/integrations/url-validation";

const testCredentialsSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("odoo"),
    credentials: z.object({
      url: z.string().url(),
      db: z.string().min(1),
      login: z.string().min(1),
      apiKey: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("web-search"),
    credentials: z.object({
      apiKey: z.string().min(1),
    }),
  }),
]);

export const POST = withAdmin(async (request) => {
  const body = await request.json();
  const parsed = testCredentialsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

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

  const urlCheck = validateExternalUrl(credentials.url);
  if (!urlCheck.valid) {
    return NextResponse.json({ error: urlCheck.error }, { status: 400 });
  }

  try {
    const url = credentials.url.trim();
    const db = credentials.db.trim();
    const login = credentials.login.trim();
    const apiKey = credentials.apiKey.trim();

    const uid = await OdooClient.authenticate({ url, db, login, apiKey });

    const client = new OdooClient({
      url,
      db,
      uid,
      apiKey,
    });
    const version = await client.version();

    return NextResponse.json({
      success: true,
      version: version.serverVersion,
      uid,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed";
    return NextResponse.json({ success: false, error: message });
  }
});
