import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/invites", () => ({
  createInvite: vi.fn(),
}));

vi.mock("@/lib/settings", () => ({
  getAllSettings: vi.fn().mockResolvedValue([]),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/providers", () => ({
  validateProviderKey: vi.fn().mockResolvedValue(true),
  PROVIDERS: {
    anthropic: {
      name: "Anthropic",
      settingsKey: "anthropic_api_key",
      envVar: "ANTHROPIC_API_KEY",
      defaultModel: "anthropic/claude-haiku-4-5-20251001",
      placeholder: "sk-ant-...",
    },
    openai: {
      name: "OpenAI",
      settingsKey: "openai_api_key",
      envVar: "OPENAI_API_KEY",
      defaultModel: "openai/gpt-4o-mini",
      placeholder: "sk-...",
    },
    google: {
      name: "Google",
      settingsKey: "google_api_key",
      envVar: "GOOGLE_API_KEY",
      defaultModel: "google/gemini-2.0-flash",
      placeholder: "AIza...",
    },
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  writeOpenClawConfig: vi.fn(),
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/workspace", () => ({
  deleteWorkspace: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      agents: {
        findFirst: vi.fn().mockResolvedValue({
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
        }),
      },
    },
  },
}));

import { appendAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/api-auth";
import { createInvite } from "@/lib/invites";
import { db } from "@/db";

const adminSession = {
  user: { id: "admin-1", email: "admin@test.com", role: "admin" },
  expires: "",
};

// ── user.invited: POST /api/users/invite ─────────────────────────────────

describe("audit: POST /api/users/invite", () => {
  let POST: typeof import("@/app/api/users/invite/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue(
      adminSession as Awaited<ReturnType<typeof requireAdmin>>
    );

    vi.mocked(createInvite).mockResolvedValue({
      id: "invite-1",
      email: "newuser@test.com",
      role: "user",
      type: "invite",
      token: "abc123",
      createdAt: new Date(),
      expiresAt: new Date(),
    } as never);

    const mod = await import("@/app/api/users/invite/route");
    POST = mod.POST;
  });

  it("logs user.invited audit event on successful invite", async () => {
    const request = new NextRequest("http://localhost:7777/api/users/invite", {
      method: "POST",
      body: JSON.stringify({ email: "newuser@test.com", role: "user" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "user.invited",
      detail: { email: "newuser@test.com", role: "user" },
    });
  });

  it("does not log audit event when invite fails (bad role)", async () => {
    const request = new NextRequest("http://localhost:7777/api/users/invite", {
      method: "POST",
      body: JSON.stringify({ role: "superadmin" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});

// ── user.deleted: DELETE /api/users/[userId] ─────────────────────────────

describe("audit: DELETE /api/users/[userId]", () => {
  let DELETE: typeof import("@/app/api/users/[userId]/route").DELETE;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue(
      adminSession as Awaited<ReturnType<typeof requireAdmin>>
    );

    const mod = await import("@/app/api/users/[userId]/route");
    DELETE = mod.DELETE;
  });

  it("logs user.deleted audit event on successful deletion", async () => {
    // Mock: select personal agents returns empty
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    // Mock: delete returns the deleted user with email
    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "user-1", email: "deleted@test.com" }]),
      }),
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/user-1", { method: "DELETE" });

    const response = await DELETE(request, {
      params: Promise.resolve({ userId: "user-1" }),
    });
    expect(response.status).toBe(200);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "user.deleted",
      resource: "user:user-1",
      detail: { email: "deleted@test.com" },
    });
  });

  it("does not log audit event when user not found", async () => {
    // Mock: select personal agents returns empty
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    // Mock: delete returns empty (user not found)
    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const request = new NextRequest("http://localhost:7777/api/users/nonexistent", {
      method: "DELETE",
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ userId: "nonexistent" }),
    });
    expect(response.status).toBe(404);

    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});

// ── config.changed: POST /api/setup/provider ─────────────────────────────

describe("audit: POST /api/setup/provider", () => {
  let POST: typeof import("@/app/api/setup/provider/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    // setup/provider uses requireAdmin directly — mock it to return session
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", role: "admin" },
      expires: "",
    } as Awaited<ReturnType<typeof requireAdmin>>);

    const mod = await import("@/app/api/setup/provider/route");
    POST = mod.POST;
  });

  it("logs config.changed audit event on successful provider setup", async () => {
    const request = new Request("http://localhost/api/setup/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-valid" }),
    });

    const response = await POST(request as any);
    expect(response.status).toBe(200);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "config.changed",
      detail: { key: "provider", provider: "anthropic" },
    });
  });

  it("does not log audit event when provider is invalid", async () => {
    const request = new Request("http://localhost/api/setup/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "unknown", apiKey: "key" }),
    });

    const response = await POST(request as any);
    expect(response.status).toBe(400);

    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});

// ── config.changed: POST /api/settings ───────────────────────────────────

describe("audit: POST /api/settings", () => {
  let POST: typeof import("@/app/api/settings/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue(
      adminSession as Awaited<ReturnType<typeof requireAdmin>>
    );

    const mod = await import("@/app/api/settings/route");
    POST = mod.POST;
  });

  it("logs config.changed audit event on successful settings update", async () => {
    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "default_provider", value: "openai" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "config.changed",
      detail: { key: "default_provider" },
    });
  });
});
