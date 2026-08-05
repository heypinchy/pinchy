// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

// The settings mock is a real in-memory store rather than a set of bare
// spies. The bug this file guards against (#1083 review) is about the value
// that survives a rejected PUT, and "setSetting was not called" is an
// assertion about the route's calls — not about what the install is left
// holding. A store lets the test read the end state.
const { settingsStore, VALID_TOKEN, ACTIVE_STATUS, statusFor } = vi.hoisted(() => {
  const settingsStore = new Map<string, string>();
  const VALID_TOKEN = "eyJ.valid.token";
  const ACTIVE_STATUS = {
    active: true,
    type: "paid" as const,
    org: "test-org",
    features: ["enterprise"],
    expiresAt: new Date("2027-01-01"),
    daysRemaining: 300,
    ver: 1,
    maxUsers: 10,
  };
  const statusFor = (token: string | undefined) =>
    token === VALID_TOKEN
      ? ACTIVE_STATUS
      : { active: false, features: [] as string[], ver: 1, maxUsers: 0 };
  return { settingsStore, VALID_TOKEN, ACTIVE_STATUS, statusFor };
});

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn();
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async (key: string) => settingsStore.get(key) ?? null),
  setSetting: vi.fn(async (key: string, value: string) => {
    settingsStore.set(key, value);
  }),
  deleteSetting: vi.fn(async (key: string) => {
    settingsStore.delete(key);
  }),
}));

vi.mock("@/lib/enterprise", () => ({
  clearLicenseCache: vi.fn(),
  // Reads the store, so it answers what the install would answer *after*
  // whatever the route did to it.
  getLicenseStatus: vi.fn(async () => statusFor(settingsStore.get("enterprise_key"))),
  validateLicenseToken: vi.fn(async (token: string) => statusFor(token)),
  isKeyFromEnv: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { getSession } from "@/lib/auth";
import { setSetting, deleteSetting } from "@/lib/settings";
import { clearLicenseCache, getLicenseStatus, validateLicenseToken } from "@/lib/enterprise";
import { appendAuditLog } from "@/lib/audit";
import { makeNextRequest } from "@/test-helpers/route";

function adminSession() {
  vi.mocked(getSession).mockResolvedValueOnce({
    user: { id: "u1", role: "admin", name: "Admin" },
  } as never);
}

async function putKey(key: unknown) {
  const { PUT } = await import("@/app/api/enterprise/key/route");
  return PUT(
    makeNextRequest("http://localhost/api/enterprise/key", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(key === undefined ? {} : { key }),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsStore.clear();
});

describe("PUT /api/enterprise/key", () => {
  it("returns 401 for unauthenticated requests", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const res = await putKey("test");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    vi.mocked(getSession).mockResolvedValueOnce({
      user: { id: "u1", role: "member", name: "User" },
    } as never);
    const res = await putKey("test");
    expect(res.status).toBe(403);
  });

  it("returns 400 for missing key", async () => {
    adminSession();
    const res = await putKey(undefined);
    expect(res.status).toBe(400);
  });

  it("saves valid key, clears cache, logs audit, returns status", async () => {
    adminSession();

    const res = await putKey(VALID_TOKEN);
    expect(res.status).toBe(200);

    // Verify save flow
    expect(setSetting).toHaveBeenCalledWith("enterprise_key", VALID_TOKEN, true);
    expect(clearLicenseCache).toHaveBeenCalled();
    expect(validateLicenseToken).toHaveBeenCalledWith(VALID_TOKEN);
    expect(appendAuditLog).toHaveBeenCalled();

    // Verify response contains status
    const body = await res.json();
    expect(body.enterprise).toBe(true);
    expect(body.type).toBe("paid");
  });

  it("returns 400 and audits the failure when the key is invalid", async () => {
    adminSession();

    const res = await putKey("invalid-token");
    expect(res.status).toBe(400);

    // A rejected license-activation attempt is a governance-relevant security
    // action and must leave a failure trail — silence is the bug.
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        actorType: "user",
        actorId: "u1",
        outcome: "failure",
      })
    );
  });

  // ── Regression: a rejected key must not cost the admin their working one ──
  //
  // The route used to write the submitted key before validating it and then
  // "roll back" with deleteSetting — which deletes rather than restores. An
  // admin on a valid paid license who pasted a typo lost it, dropped to the
  // community state, and could only recover by re-entering the original key.

  it("leaves a previously stored valid key in place when the submitted key is rejected", async () => {
    settingsStore.set("enterprise_key", VALID_TOKEN);
    adminSession();

    const res = await putKey("expired-or-typo-token");
    expect(res.status).toBe(400);

    expect(settingsStore.get("enterprise_key")).toBe(VALID_TOKEN);
    expect(deleteSetting).not.toHaveBeenCalled();
    await expect(getLicenseStatus()).resolves.toMatchObject({ active: true, type: "paid" });
  });

  it("stores nothing when a rejected key arrives on an install with no license", async () => {
    adminSession();

    const res = await putKey("garbage");
    expect(res.status).toBe(400);

    expect(settingsStore.has("enterprise_key")).toBe(false);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("does not clear the license cache when the submitted key is rejected", async () => {
    settingsStore.set("enterprise_key", VALID_TOKEN);
    adminSession();

    await putKey("expired-or-typo-token");

    // Nothing changed, so the cached verdict is still correct. Clearing it
    // would force every gate to re-derive the same answer.
    expect(clearLicenseCache).not.toHaveBeenCalled();
  });

  it("does not write the license key value into the failure audit detail", async () => {
    adminSession();

    await putKey("super-secret-invalid-token");

    const serialized = JSON.stringify(vi.mocked(appendAuditLog).mock.calls);
    expect(serialized).not.toContain("super-secret-invalid-token");
  });

  it("reports the validated status of the submitted key", async () => {
    adminSession();

    const res = await putKey(VALID_TOKEN);
    const body = await res.json();

    expect(body).toMatchObject({
      enterprise: true,
      type: ACTIVE_STATUS.type,
      org: ACTIVE_STATUS.org,
      expiresAt: ACTIVE_STATUS.expiresAt.toISOString(),
      daysRemaining: ACTIVE_STATUS.daysRemaining,
    });
  });
});
