import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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
  getAllSettings: vi.fn().mockResolvedValue([]),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/settings-timezone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings-timezone")>()),
  getOrgTimezone: vi.fn().mockResolvedValue("UTC"),
  setOrgTimezone: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/lib/auth";
import { getAllSettings } from "@/lib/settings";
import { appendAuditLog } from "@/lib/audit";
import { getOrgTimezone, setOrgTimezone } from "@/lib/settings-timezone";
import { after } from "next/server";

describe("GET /api/settings", () => {
  let GET: typeof import("@/app/api/settings/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/settings/route");
    GET = mod.GET;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when user is not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const response = await GET();
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns settings when user is admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    vi.mocked(getAllSettings).mockResolvedValueOnce([
      { key: "default_provider", value: "anthropic", encrypted: false },
    ]);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual([{ key: "default_provider", value: "anthropic", encrypted: false }]);
  });

  it("masks encrypted values", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    vi.mocked(getAllSettings).mockResolvedValueOnce([
      { key: "anthropic_api_key", value: "sk-secret", encrypted: true },
    ]);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body[0].value).toBe("••••••••");
  });
});

describe("POST /api/settings", () => {
  let POST: typeof import("@/app/api/settings/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/settings/route");
    POST = mod.POST;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "foo", value: "bar" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when user is not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "foo", value: "bar" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it.each([
    "ollama_local_url",
    "domain",
    "enterprise_key",
    "telegram_bot_token:abc",
    "default_provider",
    "anthropic_api_key",
  ])("refuses %s — it has a dedicated route with its own validation and audit", async (key) => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    const { setSetting } = await import("@/lib/settings");

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: "x" }),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect((await response.json()).details.fieldErrors.key).toBeDefined();
    expect(setSetting).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("refuses a member-access policy key — those go through /api/settings/governance", async () => {
    // Written here, a switch would get a value-less `config.changed` row and
    // skip the OpenClaw/Telegram refresh that closes a member's Telegram door.
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    const { setSetting } = await import("@/lib/settings");

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "policy.member_personal_agents", value: "false" }),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect((await response.json()).details.fieldErrors.key.join(" ")).toMatch(
      /\/api\/settings\/governance/
    );
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("returns 400 on missing key (no longer crashes with 500)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const { setSetting } = await import("@/lib/settings");

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "anything" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.key).toBeDefined();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("returns 400 on non-string key", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const { setSetting } = await import("@/lib/settings");

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: 42, value: "x" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("returns 400 on empty key", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const { setSetting } = await import("@/lib/settings");

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "", value: "x" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("returns 400 on missing value", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    // The allowed key, so the 400 can only come from the missing value — with
    // any other key the allow-list would answer first and this would prove
    // nothing about `value`.
    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "org.timezone" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(setOrgTimezone).not.toHaveBeenCalled();
  });

  it("returns 400 on a non-string value for the allowed key", async () => {
    // An array, not a number: `["Europe/Vienna"]` stringifies to a valid zone,
    // so only the schema's string check stops it. A number would also fail
    // the route's IANA check and pass with the type check removed.
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "org.timezone", value: ["Europe/Vienna"] }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(setOrgTimezone).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Invalid JSON body");
  });

  it("schedules the timezone audit write via after() instead of fire-and-forget", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    vi.mocked(getOrgTimezone).mockResolvedValueOnce("UTC");

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "org.timezone", value: "Europe/Vienna" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    expect(setOrgTimezone).toHaveBeenCalledWith("Europe/Vienna");
    expect(after).toHaveBeenCalledTimes(1);
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "admin-1",
        eventType: "settings.updated",
        detail: { changes: { timezone: { from: "UTC", to: "Europe/Vienna" } } },
      })
    );
  });
});
