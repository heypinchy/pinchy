import { NextResponse, after } from "next/server";
import { desc, inArray } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { apiKeys, users } from "@/db/schema";
import { parseRequestBody } from "@/lib/api-validation";
import { appendAuditLog } from "@/lib/audit";
import { createApiKeySchema } from "@/lib/schemas/api-keys";
import { extractScopes, mapScopes, parsePermissions } from "@/lib/api-key-scopes";
import { PINCHY_SERVICE_ACCOUNT_ID, parseCreator } from "@/lib/api-key-identity";

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
      // The ORG owns the key, not this admin (lib/api-key-identity.ts). The
      // plugin calls this field `userId` and stores it verbatim as
      // `referenceId`, without validating that a matching user exists — so
      // "the org" fits through it unchanged. Note the admin below is
      // provenance only: the key's authority is its own `scopes`, and it
      // keeps working after they leave, which is the entire point.
      userId: PINCHY_SERVICE_ACCOUNT_ID,
      metadata: { createdBy: { id: session.user.id!, name: session.user.name ?? "" } },
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
 * so that endpoint would filter by the calling admin's own id — which under
 * Model 2 matches nothing at all, since keys are issued against the org
 * service account rather than any user. Org-wide is the product decision
 * anyway (every admin sees and can revoke every key), so this route reads
 * `schema.apiKeys` directly via Drizzle instead, with no `referenceId`
 * filter. `DELETE /api-keys/[keyId]` makes the same bypass for revocation,
 * for the same reason.
 *
 * `apiKeys.permissions` and `apiKeys.metadata` (db/schema.ts) are `text`
 * columns holding JSON strings — `auth.api.listApiKeys` auto-parses them, but
 * a raw Drizzle read does not, hence `parsePermissions` / `parseCreator`.
 *
 * Read-only: no audit entry (audit-exempt below).
 */
// audit-exempt: read-only masked list, no state change
export const GET = withAdmin(async () => {
  const rows = await db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));

  // Paired with its row rather than kept in a parallel array: zipping by index
  // would silently rot the moment anything reorders or filters one side.
  const withCreator = rows.map((row) => ({ row, creator: parseCreator(row.metadata) }));

  // Which creators can still log in? One query for the whole page, not one
  // per key. Note this resolves ONLY liveness — the name always comes from
  // the snapshot, so it survives the user row being deleted outright.
  //
  // This is not the `resolveIssuer` lookup Model 2 removed: that one ran per
  // request on /api/v1/*, to assert that a key acted on a human's behalf.
  // This is an admin-facing rotation hint on a settings page, and nothing
  // downstream is authorized by it.
  const creatorIds = [
    ...new Set(withCreator.map(({ creator }) => creator?.id).filter((id) => id !== undefined)),
  ];
  const activeCreatorIds = new Set(
    creatorIds.length === 0
      ? []
      : (
          await db
            .select({ id: users.id, banned: users.banned })
            .from(users)
            .where(inArray(users.id, creatorIds))
        )
          // A missing row means the account is gone; `banned` means it's
          // disabled. Both are "no longer works here" — the only distinction
          // that matters for "should we rotate this key?".
          .filter((u) => !u.banned)
          .map((u) => u.id)
  );

  // Mask via WHITELIST — never spread the raw row. `key` (hashed), `prefix`,
  // `referenceId`, the raw `metadata`, and every other column not listed
  // below must never leak onto this endpoint's response shape.
  const keys = withCreator.map(({ row: k, creator }) => {
    return {
      id: k.id,
      name: k.name,
      start: k.start ?? null,
      scopes: extractScopes(parsePermissions(k.permissions)),
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
      lastRequest: k.lastRequest,
      enabled: k.enabled,
      // Provenance, not authority (lib/api-key-identity.ts): the key's own
      // scopes are its permissions, and it keeps working after this person
      // leaves — by design. Surfacing them is what makes "whose key is this,
      // do we rotate it now they're gone?" answerable, which is the
      // compensating control for the one-time-plaintext custody gap, not
      // decoration. `null` for a key predating the snapshot or carrying a
      // corrupt payload — the UI must render that honestly rather than guess.
      createdBy: creator && { ...creator, active: activeCreatorIds.has(creator.id) },
    };
  });

  return NextResponse.json({ keys });
});
