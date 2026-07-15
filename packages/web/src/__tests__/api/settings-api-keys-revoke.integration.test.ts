// Real-DB integration test proving the org-wide revoke security guarantee
// (#572 follow-up, Task C): a direct Drizzle DELETE against the `apikey`
// table must ACTUALLY revoke the key, not merely remove the row while a
// cache keeps it authenticating.
//
// Why this matters: `DELETE /api/settings/api-keys/[keyId]` deliberately
// bypasses better-auth's own `auth.api.deleteApiKey` endpoint (which is
// session-scoped — it can only revoke the calling admin's own keys, no
// `userId`/org override, and Pinchy runs no `organization` plugin) in favor
// of `db.delete(apiKeys).where(eq(apiKeys.id, keyId))` directly, so ANY
// admin can revoke ANY key (see route.ts's docblock). That bypass is only
// safe if better-auth resolves every `verifyApiKey` call straight from the
// database — if the plugin (or a future config change) introduced a
// secondary-storage cache, a deleted row could keep authenticating via the
// cache and this "revoke" would be a no-op security theater.
//
// Static confirmation (read alongside this test, not a substitute for it):
// `lib/auth.ts` configures no `secondaryStorage` on the Better Auth instance
// and no `storage` option on the `apiKey()` plugin config, so the plugin's
// own default applies — `@better-auth/api-key/dist/index.mjs`:
// `storage: config?.storage ?? "database"`. In `"database"` mode,
// `getApiKey$1`/`validateApiKey` always call `ctx.context.adapter.findOne(...)`
// (a live DB read) and never consult `ctx.context.secondaryStorage`. This
// test is the dynamic proof: if that ever regressed (e.g. a future
// dependency bump silently switched Pinchy onto a cache), the flow below
// would fail at the FINAL assertion — `valid` would stay `true` after
// deletion — and that must stop the deploy.
//
// Provisioned by global-setup.ts (fresh migrated DB) and truncated between
// tests (setup.ts). Everything runs for real — no mocks.

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { auth } from "@/lib/auth";

async function seedUser() {
  // signUpEmail wires through Better Auth so the user row matches production.
  const result = await auth.api.signUpEmail({
    body: { name: "Revoke Admin", email: "revoke-admin@test.local", password: "apipassword123" },
  });
  return result.user.id;
}

describe("org-wide revoke: a DB-deleted apikey row actually fails verifyApiKey (#572, Task C)", () => {
  it("create -> verify valid:true -> direct DB delete -> verify valid:false", async () => {
    const userId = await seedUser();

    const created = await auth.api.createApiKey({
      body: { name: "revoke-me", userId },
    });

    // Anchor: the key genuinely authenticates before revocation. Without
    // this passing first, a false valid:false below would prove nothing.
    const before = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect(before.valid).toBe(true);
    expect(before.error).toBeNull();
    expect(before.key?.id).toBe(created.id);

    // The org-wide revoke path: a direct Drizzle delete, exactly what
    // DELETE /api/settings/api-keys/[keyId] does (route.ts) — bypassing
    // auth.api.deleteApiKey entirely.
    const deleted = await db.delete(apiKeys).where(eq(apiKeys.id, created.id));
    void deleted; // postgres-js delete result; the row-count assertion below is the real proof.

    // The row is actually gone (sanity check on the delete itself, before
    // asserting on verifyApiKey's behavior).
    const rowsAfterDelete = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(rowsAfterDelete).toHaveLength(0);

    // THE proof: the same plaintext key that verified moments ago must now
    // fail. If this is still `true`, better-auth kept the key alive via a
    // cache and the whole org-wide-bypass design is unsafe — see the file
    // header for what that would mean.
    const after = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect(after.valid).toBe(false);
    expect(after.key).toBeNull();
  });
});
