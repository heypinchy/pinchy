// audit-exempt: read-only credential test, no state changes
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { OdooClient } from "odoo-node";
import { getSession } from "@/lib/auth";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { getPipedriveBaseUrl } from "@/lib/integrations/pipedrive-api";

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
    type: z.literal("pipedrive"),
    credentials: z.object({
      apiToken: z.string().min(1),
    }),
  }),
]);

export async function POST(request: NextRequest) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = testCredentialsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  if (parsed.data.type === "pipedrive") {
    const { apiToken } = parsed.data.credentials;

    try {
      const response = await fetch(`${getPipedriveBaseUrl()}/v1/users/me`, {
        headers: { "x-api-token": apiToken },
      });
      const data = await response.json();

      if (!data.success) {
        return NextResponse.json({
          success: false,
          error: data.error || "Authentication failed",
        });
      }

      return NextResponse.json({
        success: true,
        companyDomain: data.data.company_domain,
        companyName: data.data.company_name,
        userId: data.data.id,
        userName: data.data.name,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection failed";
      return NextResponse.json({ success: false, error: message });
    }
  }

  // Odoo
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
}
