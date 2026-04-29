import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/encryption";
import { appendAuditLog } from "@/lib/audit";
import { odooCredentialsSchema, odooConnectionDataSchema } from "@/lib/integrations/odoo-schema";
import {
  pipedriveCredentialsSchema,
  pipedriveConnectionDataSchema,
} from "@/lib/integrations/pipedrive-schema";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { maskConnectionCredentials } from "@/lib/integrations/mask-credentials";

const createIntegrationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("odoo"),
    name: z.string().min(1).max(100),
    description: z.string().max(500).default(""),
    credentials: odooCredentialsSchema,
    data: odooConnectionDataSchema.optional(),
  }),
  z.object({
    type: z.literal("pipedrive"),
    name: z.string().min(1).max(100),
    description: z.string().max(500).default(""),
    credentials: pipedriveCredentialsSchema,
    data: pipedriveConnectionDataSchema.optional(),
  }),
  z.object({
    type: z.literal("web-search"),
    name: z.string().min(1).max(100),
    description: z.string().max(500).default(""),
    credentials: z.object({ apiKey: z.string().min(1) }),
  }),
]);

export async function GET() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const connections = await db.select().from(integrationConnections);

  // Decrypt per row and isolate failures: if ENCRYPTION_KEY changed (e.g. an
  // admin accidentally overrode the persisted key via .env), some rows can no
  // longer be decrypted. A single poison row must NOT crash the whole list —
  // that used to silently hide all integrations, including freshly-added ones
  // that would decrypt fine. Flag unreadable rows so the UI can offer Delete.
  const masked = connections.map((conn) => {
    try {
      return {
        ...conn,
        credentials: maskConnectionCredentials(conn.type, conn.credentials, decrypt),
        cannotDecrypt: false,
      };
    } catch (err) {
      console.warn(
        `[integrations] Cannot decrypt credentials for connection ${conn.id} (${conn.name}). ` +
          `ENCRYPTION_KEY may have changed. The admin can delete this row via the UI.`,
        err
      );
      return {
        id: conn.id,
        type: conn.type,
        name: conn.name,
        description: conn.description,
        status: conn.status,
        data: null,
        createdAt: conn.createdAt,
        updatedAt: conn.updatedAt,
        credentials: null,
        cannotDecrypt: true,
      };
    }
  });

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

  const { type, name, description, credentials } = parsed.data;

  // Singleton types: only one connection of this type allowed
  if (type === "web-search") {
    const existing = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.type, "web-search"));
    if (existing.length > 0) {
      return NextResponse.json(
        { error: "A Web Search connection already exists. Delete it first to add a new one." },
        { status: 409 }
      );
    }
  }

  if (parsed.data.type === "odoo") {
    const urlCheck = validateExternalUrl(parsed.data.credentials.url);
    if (!urlCheck.valid) {
      return NextResponse.json({ error: urlCheck.error }, { status: 400 });
    }
  }

  const encryptedCredentials = encrypt(JSON.stringify(credentials));
  const data =
    parsed.data.type === "odoo" || parsed.data.type === "pipedrive"
      ? (parsed.data.data ?? null)
      : null;

  const [connection] = await db
    .insert(integrationConnections)
    .values({
      type,
      name,
      description,
      credentials: encryptedCredentials,
      data,
    })
    .returning();

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "config.changed",
    resource: `integration:${connection.id}`,
    detail: { action: "integration_created", type, name },
    outcome: "success",
  }).catch(console.error);

  return NextResponse.json(
    {
      ...connection,
      credentials: maskConnectionCredentials(type, connection.credentials, decrypt),
    },
    { status: 201 }
  );
}
