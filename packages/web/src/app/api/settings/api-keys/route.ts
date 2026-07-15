import { NextResponse, after } from "next/server";
import { headers } from "next/headers";
import { withAdmin } from "@/lib/api-auth";
import { auth } from "@/lib/auth";
import { parseRequestBody } from "@/lib/api-validation";
import { appendAuditLog } from "@/lib/audit";
import { createApiKeySchema } from "@/lib/schemas/api-keys";
import { extractScopes, mapScopes } from "@/lib/api-key-scopes";

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
 * List Agent Provisioning API keys, masked (#572, Task 5.2).
 *
 * Scope decision: better-auth's `listApiKeys` endpoint has no server-side
 * `userId` override (unlike `createApiKey`) — it always resolves
 * `referenceId` from the caller's OWN session via `sessionMiddleware`, with
 * an org-wide alternative only when an `organizationId` is supplied AND the
 * `organization` plugin is registered. Pinchy does not register that plugin
 * (see lib/auth.ts's `plugins` array), so there is no supported way to list
 * every admin's keys in one call today. This route therefore returns the
 * CALLING ADMIN'S OWN keys, forwarding their session via `headers`. A future
 * org-wide view would need either the `organization` plugin or a direct
 * `db` query bypassing this endpoint — out of scope for #572 Tasks 5.1/5.2.
 *
 * Read-only: no audit entry (audit-exempt below).
 */
// audit-exempt: read-only masked list, no state change
export const GET = withAdmin(async () => {
  const { apiKeys } = await auth.api.listApiKeys({ headers: await headers() });

  // Mask via WHITELIST — never spread the raw row. The hashed `key` never
  // appears on this endpoint's row shape at all, but `permissions`/
  // `metadata`/`referenceId`/`prefix` do, and must not leak either.
  const keys = apiKeys.map((key) => ({
    id: key.id,
    name: key.name,
    start: key.start ?? null,
    scopes: extractScopes(key.permissions),
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    lastRequest: key.lastRequest,
    enabled: key.enabled,
  }));

  return NextResponse.json({ keys });
});
