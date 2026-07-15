import { NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";

type RouteContext = { params: Promise<{ keyId: string }> };

/**
 * Revoke an Agent Provisioning API key, org-wide (#572 follow-up).
 *
 * Same org-wide rationale as the sibling `GET /api/settings/api-keys`
 * rewrite: better-auth's `deleteApiKey` is session-scoped (it can only
 * revoke the CALLING admin's own keys — no `userId`/org override, and
 * Pinchy runs no `organization` plugin). That would leave a key un-revocable
 * by anyone but its issuer, a governance hole if that admin has left. So
 * this route deletes directly from `schema.apiKeys` via Drizzle, bypassing
 * `auth.api.deleteApiKey` — any admin can revoke any key.
 *
 * Hard delete = revoke: a deleted row can never authenticate again PROVIDED
 * better-auth reads keys straight from the DB on every verify, with no
 * secondary-storage cache keeping a deleted key "alive". `lib/auth.ts`
 * configures no `secondaryStorage` (and the `apiKey()` plugin options carry
 * no `storage` override), so the plugin's own default (`storage:
 * "database"`) applies — every `verifyApiKey` call reads the row directly.
 *
 * The WHERE below is the only thing scoping this delete to one key — Drizzle
 * offers no type-level guard against an unpinned or mis-pinned `db.delete()`,
 * and either would wipe every key in the org while still answering 200. Both
 * that pin and the no-cache claim above are proven against a real Postgres,
 * through this route, in settings-api-keys-revoke.integration.test.ts.
 *
 * CRITICAL governance point (design D2), same as POST/GET on the parent
 * route: this is a session-authenticated admin action — a human admin
 * revokes the key through the settings UI — so the audit actor is the ADMIN
 * (`actorType: "user"`, `actorId: session.user.id`), not `"api_key"`.
 */
export const DELETE = withAdmin<RouteContext>(async (_req, { params }, session) => {
  const { keyId } = await params;

  const [existing] = await db
    .select({ name: apiKeys.name })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId));
  if (!existing) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  await db.delete(apiKeys).where(eq(apiKeys.id, keyId));

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "api_key.deleted",
      resource: `api_key:${keyId}`,
      // name captured BEFORE the delete (`existing`, above) — the row is
      // gone by the time this runs. Can be null in the DB (name is a
      // nullable column) — coalesce so DeleteDetail always gets a string.
      detail: { name: existing.name ?? "" },
      outcome: "success",
    })
  );

  return NextResponse.json({ success: true });
});
