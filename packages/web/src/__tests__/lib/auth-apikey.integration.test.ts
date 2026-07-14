// Real-DB integration test for the @better-auth/api-key plugin (#572).
//
// The unit guard (auth-apikey-plugin.test.ts) proves the plugin is registered,
// but only a round-trip against a real Postgres proves the HAND-WRITTEN `apikey`
// table (db/schema.ts) actually matches the plugin's `apiKeySchema` — a missing
// column or wrong nullability would surface here as an insert/select failure.
//
// Provisioned by global-setup.ts (fresh migrated DB) and truncated between tests
// (setup.ts). Everything runs for real — no mocks.

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { auth } from "@/lib/auth";

async function seedUser() {
  // signUpEmail wires through Better Auth so the user row matches production.
  const result = await auth.api.signUpEmail({
    body: { name: "API Consumer", email: "api@test.local", password: "apipassword123" },
  });
  return result.user.id;
}

describe("@better-auth/api-key plugin (integration)", () => {
  it("creates a pinchy_-prefixed key and persists it to the hand-written apikey table", async () => {
    const userId = await seedUser();

    const created = await auth.api.createApiKey({
      body: { name: "provisioning-token", userId },
    });

    // The one-time plaintext key is returned exactly once, on create.
    expect(typeof created.key).toBe("string");
    expect(created.key.startsWith("pinchy_")).toBe(true);
    expect(created.name).toBe("provisioning-token");
    expect(created.enabled).toBe(true);

    // Row landed in OUR table with the columns the plugin expects. If any
    // hand-written column were missing/misnamed, the insert above would have
    // thrown before we got here.
    const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].referenceId).toBe(userId);
    expect(rows[0].configId).toBe("default");
    // Plaintext key is never stored — only its SHA-256 hash.
    expect(rows[0].key).not.toBe(created.key);
  });

  it("verifies a freshly created key via auth.api.verifyApiKey", async () => {
    const userId = await seedUser();
    const created = await auth.api.createApiKey({
      body: { name: "verify-me", userId },
    });

    const result = await auth.api.verifyApiKey({ body: { key: created.key } });

    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
    expect(result.key?.id).toBe(created.id);
  });
});
