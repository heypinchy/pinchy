import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/encryption";
import { appendAuditLog } from "@/lib/audit";
import {
  odooCredentialsSchema,
  odooConnectionDataSchema,
  maskCredentials,
} from "@/lib/integrations/odoo-schema";
import { validateExternalUrl } from "@/lib/integrations/url-validation";

const createIntegrationSchema = z.object({
  type: z.literal("odoo"),
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  credentials: odooCredentialsSchema,
  data: odooConnectionDataSchema.optional(),
});

export async function GET() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const connections = await db.select().from(integrationConnections);

  const masked = connections.map((conn) => ({
    ...conn,
    credentials: maskCredentials(conn.credentials, decrypt),
  }));

  return NextResponse.json(masked);
}

export async function POST(request: NextRequest) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createIntegrationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { type, name, description, credentials, data } = parsed.data;

  const urlCheck = validateExternalUrl(credentials.url);
  if (!urlCheck.valid) {
    return NextResponse.json({ error: urlCheck.error }, { status: 400 });
  }

  const encryptedCredentials = encrypt(JSON.stringify(credentials));

  const [connection] = await db
    .insert(integrationConnections)
    .values({
      type,
      name,
      description,
      credentials: encryptedCredentials,
      data: data ?? null,
    })
    .returning();

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "config.changed",
    resource: `integration:${connection.id}`,
    detail: { action: "integration_created", type, name },
  }).catch(() => {});

  return NextResponse.json(
    {
      ...connection,
      credentials: { url: credentials.url, db: credentials.db, login: credentials.login },
    },
    { status: 201 }
  );
}
