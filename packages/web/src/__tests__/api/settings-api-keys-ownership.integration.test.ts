// Real-DB integration test for API-key OWNERSHIP — the Model 2 contract
// (#572, B1).
//
// The question this answers: when the admin who created a key leaves the
// company, what happens to the key?
//
// Pinchy's answer is "nothing, by design", because the key was never theirs.
// It belongs to the organization (`PINCHY_SERVICE_ACCOUNT_ID`), and the admin
// is recorded only as provenance. That is the machine-owned model — GCP
// service account keys, Datadog org API keys — and it is the only model that
// lets automation survive an offboarding. See lib/api-key-identity.ts for why
// the human-owned alternative doesn't work for Pinchy specifically.
//
// This suite is the executable half of that argument. It must fail loudly if
// anyone re-attaches keys to their creator — most plausibly by "fixing" the
// missing FK on `apikey.reference_id`, which under Model 2 is correctly
// absent: the column points at a service account, not a user, so an FK to
// `users` would be a category error AND would cascade-delete live automation
// credentials the moment someone offboards.
//
// Provisioned by global-setup.ts and truncated between tests (setup.ts). Only
// the session and `after()` are faked; the DB, the key plugin, and the audit
// chain run for real.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const pendingAfter: Promise<unknown>[] = [];
async function flushAfter(): Promise<void> {
  while (pendingAfter.length > 0) {
    await Promise.allSettled(pendingAfter.splice(0));
  }
}

afterEach(async () => {
  await flushAfter();
});

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((fn: () => void | Promise<void>) => {
      try {
        const result = fn();
        if (result instanceof Promise) pendingAfter.push(result.catch(() => {}));
      } catch {
        // Swallowed — matches Next's after() error handling.
      }
    }),
  };
});

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession: vi.fn() };
});

import { db } from "@/db";
import { apiKeys, users } from "@/db/schema";
import { auth, getSession } from "@/lib/auth";
import { PINCHY_SERVICE_ACCOUNT_ID, parseCreator } from "@/lib/api-key-identity";
import { POST, GET } from "@/app/api/settings/api-keys/route";

async function seedAdminSession(name = "Cara Admin", email = "cara@test.local") {
  const result = await auth.api.signUpEmail({
    body: { name, email, password: "apipassword123" },
  });
  const adminId = result.user.id;
  await db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));
  vi.mocked(getSession).mockResolvedValue({
    user: { id: adminId, name, email, role: "admin" },
  } as unknown as Awaited<ReturnType<typeof getSession>>);
  return adminId;
}

function createRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/settings/api-keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Issues a key through the real route and returns the one-time plaintext. */
async function issueKey(name = "CI Deploy", scopes = ["agents:read"]) {
  const response = await POST(createRequest({ name, scopes }), undefined);
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; key: string; name: string };
}

async function verifies(key: string): Promise<boolean> {
  return (await auth.api.verifyApiKey({ body: { key } })).valid;
}

describe("API key ownership (Model 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingAfter.length = 0;
  });

  it("issues the key against the org service account, NOT the admin's user id", async () => {
    const adminId = await seedAdminSession();

    const created = await issueKey();

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(row.referenceId).toBe(PINCHY_SERVICE_ACCOUNT_ID);
    // The load-bearing negative: the moment referenceId is a user id again,
    // the key is making a claim about a human's authority that nothing keeps
    // true, which is exactly the incoherent middle model B1 identified.
    expect(row.referenceId).not.toBe(adminId);
  });

  it("records the creating admin as provenance in metadata", async () => {
    const adminId = await seedAdminSession("Cara Admin");

    const created = await issueKey();

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    // Name snapshotted, not joined: it has to stay readable after the user
    // row is gone — see the offboarding test below.
    expect(parseCreator(row.metadata)).toEqual({ id: adminId, name: "Cara Admin" });
  });

  // ── THE Model 2 contract ────────────────────────────────────────────────

  it("keeps working after the creating admin's account is deleted outright", async () => {
    const adminId = await seedAdminSession();
    const created = await issueKey();
    expect(await verifies(created.key)).toBe(true);

    // Offboarding, in its harshest form: the user row is gone entirely.
    await db.delete(users).where(eq(users.id, adminId));

    // Automation does not care that someone changed jobs. If this ever fails,
    // the likely cause is an FK added to `apikey.reference_id` — which would
    // cascade-delete every key its creator issued. Deliberately not there.
    expect(await verifies(created.key)).toBe(true);
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(row).toBeDefined();
    expect(row.enabled).toBe(true);
  });

  // ── The compensating control (see lib/api-key-identity.ts) ──────────────
  //
  // Model 2 doesn't solve custody: the one-time plaintext was seen only by
  // its creator, so a departed admin may still hold a working org credential.
  // The answer is operational — surface WHO created each key and whether
  // they're still around, so "what do we rotate now Cara's gone?" has an
  // answer. These tests are that control; without them Model 2 is strictly
  // weaker than the human-owned alternative.

  it("still names the departed creator, from the snapshot, and flags them inactive", async () => {
    const adminId = await seedAdminSession("Cara Admin");
    const created = await issueKey("CI Deploy");

    await db.delete(users).where(eq(users.id, adminId));
    // A second admin, still employed, opens the settings page.
    await seedAdminSession("Dara Admin", "dara@test.local");

    const response = await GET(
      new NextRequest("http://localhost/api/settings/api-keys"),
      undefined
    );
    expect(response.status).toBe(200);
    const { keys } = (await response.json()) as {
      keys: { id: string; createdBy: { id: string; name: string; active: boolean } | null }[];
    };

    const listed = keys.find((k) => k.id === created.id);
    // The whole point of snapshotting the name: "Cara Admin" survives Cara's
    // user row. A join for the NAME would render this null and leave Dara
    // unable to tell whose key this is — precisely when she most needs to
    // know. Only the liveness flag is resolved live, and it is what turns
    // this row into a rotation prompt.
    expect(listed?.createdBy).toEqual({ id: adminId, name: "Cara Admin", active: false });
  });

  it("flags a banned creator inactive too — deactivation counts, not just deletion", async () => {
    const adminId = await seedAdminSession("Cara Admin");
    const created = await issueKey("CI Deploy");

    // Offboarding as it usually happens: the account is disabled, not purged.
    await db.update(users).set({ banned: true }).where(eq(users.id, adminId));

    const response = await GET(
      new NextRequest("http://localhost/api/settings/api-keys"),
      undefined
    );
    const { keys } = (await response.json()) as {
      keys: { id: string; createdBy: { name: string; active: boolean } | null }[];
    };

    expect(keys.find((k) => k.id === created.id)?.createdBy).toEqual({
      id: adminId,
      name: "Cara Admin",
      active: false,
    });
  });

  it("marks a serving admin's key active", async () => {
    const adminId = await seedAdminSession("Cara Admin");
    const created = await issueKey("CI Deploy");

    const response = await GET(
      new NextRequest("http://localhost/api/settings/api-keys"),
      undefined
    );
    const { keys } = (await response.json()) as {
      keys: { id: string; createdBy: { id: string; name: string; active: boolean } | null }[];
    };

    expect(keys.find((k) => k.id === created.id)?.createdBy).toEqual({
      id: adminId,
      name: "Cara Admin",
      active: true,
    });
  });

  it("never exposes the hashed key, prefix, or referenceId on the settings list", async () => {
    await seedAdminSession();
    await issueKey();

    const response = await GET(
      new NextRequest("http://localhost/api/settings/api-keys"),
      undefined
    );
    const { keys } = (await response.json()) as { keys: Record<string, unknown>[] };

    // Whitelist assertion: adding `createdBy` must not have turned the mask
    // into a spread of the raw row.
    expect(Object.keys(keys[0]).sort()).toEqual(
      [
        "createdAt",
        "createdBy",
        "enabled",
        "expiresAt",
        "id",
        "lastRequest",
        "name",
        "scopes",
        "start",
      ].sort()
    );
  });
});
