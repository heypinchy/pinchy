import { NextResponse, after } from "next/server";
import { desc } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { parseRequestBody } from "@/lib/api-validation";
import { appendAuditLog } from "@/lib/audit";
import { createApiKeySchema } from "@/lib/schemas/api-keys";
import { extractScopes, mapScopes, parsePermissions } from "@/lib/api-key-scopes";

/**
 * Issue an Agent Provisioning API key (#572, Task 5.1).
 *
 * CRITICAL governance point (design D2): this route is session-authenticated
 * — a human admin issues the key through the settings UI — so the audit
 * actor is the ADMIN (`actorType: "user"`, `actorId: session.user.id`), not
 * `"api_key"`. Contrast with the key-authenticated `/api/v1/agents` routes,
 * where an API key performs the action and IS the actor. The event's
 * *resource* is the api_key being created either way.
 *
 * `permissions`/`userId` are server-only fields on better-auth's
 * `createApiKey` endpoint — passing `headers`/`request` here would make it
 * treat this as a client (session) request and throw `SERVER_ONLY_PROPERTY`.
 * So this call intentionally carries no headers, only `body`.
 */
export const POST = withAdmin(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(createApiKeySchema, request);
  if ("error" in parsed) return parsed.error;
  const { name, scopes, expiresInDays } = parsed.data;

  const created = await auth.api.createApiKey({
    body: {
      name,
      permissions: mapScopes(scopes),
      // The plugin's expiresIn is SECONDS; the request schema's
      // expiresInDays is DAYS — convert, or omit entirely (never expires).
      expiresIn: expiresInDays ? expiresInDays * 86400 : undefined,
      // The issuing admin owns the key (referenceId) — no session/headers
      // are forwarded, so this is the only way better-auth knows the owner.
      userId: session.user.id!,
    },
  });

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "api_key.created",
      resource: `api_key:${created.id}`,
      // NEVER the plaintext key here — that's the whole point of one-time
      // display. The audit trail records that a key was issued and with
      // which scopes, not the secret itself.
      detail: { id: created.id, name: created.name, scopes, expiresAt: created.expiresAt },
      outcome: "success",
    })
  );

  // One-time plaintext: created.key is the only response that will ever
  // carry the secret. Every subsequent read (GET below) returns it masked.
  return NextResponse.json(
    { id: created.id, key: created.key, name: created.name, scopes },
    { status: 201 }
  );
});

/**
 * List ALL Agent Provisioning API keys org-wide, masked (#572).
 *
 * Scope decision — org-wide, deliberately bypassing better-auth's endpoint:
 * better-auth's `listApiKeys` has no server-side `userId` override (unlike
 * `createApiKey`) — it always resolves `referenceId` from the CALLER'S OWN
 * session via `sessionMiddleware`, with an org-wide alternative only when an
 * `organizationId` is supplied AND the `organization` plugin is registered.
 * Pinchy runs no `organization` plugin (see lib/auth.ts's `plugins` array),
 * so that endpoint can only ever return the calling admin's own keys. That
 * is a governance hole: if the admin who issued a key leaves, no other admin
 * can see or revoke it. The product decision is org-wide — every admin sees
 * and can revoke every key — so this route reads `schema.apiKeys` directly
 * via Drizzle instead, with no `referenceId` filter. `DELETE
 * /api-keys/[keyId]` makes the same bypass for revocation, for the same
 * reason.
 *
 * `apiKeys.permissions` (db/schema.ts) is a `text` column holding a JSON
 * string — `auth.api.listApiKeys` auto-parses it, but a raw Drizzle read
 * does not, hence `parsePermissions` before `extractScopes`.
 *
 * Read-only: no audit entry (audit-exempt below).
 */
// audit-exempt: read-only masked list, no state change
export const GET = withAdmin(async () => {
  const rows = await db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));

  // Mask via WHITELIST — never spread the raw row. `key` (hashed), `prefix`,
  // `referenceId`, `metadata`, and every other column not listed below must
  // never leak onto this endpoint's response shape.
  const keys = rows.map((k) => ({
    id: k.id,
    name: k.name,
    start: k.start ?? null,
    scopes: extractScopes(parsePermissions(k.permissions)),
    createdAt: k.createdAt,
    expiresAt: k.expiresAt,
    lastRequest: k.lastRequest,
    enabled: k.enabled,
  }));

  return NextResponse.json({ keys });
});
