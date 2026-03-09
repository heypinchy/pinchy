import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-auth");
vi.mock("@/lib/enterprise");

import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { NextResponse } from "next/server";

const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 });
const adminSession = { user: { id: "admin-1", role: "admin" }, session: {} };

beforeEach(() => {
  vi.clearAllMocks();
  (requireAdmin as any).mockResolvedValue(forbidden);
  (isEnterprise as any).mockResolvedValue(true);
});

describe("groups API security", () => {
  it("GET /api/groups rejects non-admin", async () => {
    const { GET } = await import("@/app/api/groups/route");
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("POST /api/groups rejects non-admin", async () => {
    const { POST } = await import("@/app/api/groups/route");
    const req = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ name: "Test" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req as any);
    expect(res.status).toBe(403);
  });

  it("PATCH /api/groups/:id rejects non-admin", async () => {
    const { PATCH } = await import("@/app/api/groups/[groupId]/route");
    const req = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({ name: "Test" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req as any, { params: Promise.resolve({ groupId: "g1" }) });
    expect(res.status).toBe(403);
  });

  it("DELETE /api/groups/:id rejects non-admin", async () => {
    const { DELETE } = await import("@/app/api/groups/[groupId]/route");
    const req = new Request("http://localhost", { method: "DELETE" });
    const res = await DELETE(req as any, { params: Promise.resolve({ groupId: "g1" }) });
    expect(res.status).toBe(403);
  });

  it("GET /api/groups/:id/members rejects non-admin", async () => {
    const { GET } = await import("@/app/api/groups/[groupId]/members/route");
    const req = new Request("http://localhost", { method: "GET" });
    const res = await GET(req as any, { params: Promise.resolve({ groupId: "g1" }) });
    expect(res.status).toBe(403);
  });

  it("PUT /api/groups/:id/members rejects non-admin", async () => {
    const { PUT } = await import("@/app/api/groups/[groupId]/members/route");
    const req = new Request("http://localhost", {
      method: "PUT",
      body: JSON.stringify({ userIds: [] }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req as any, { params: Promise.resolve({ groupId: "g1" }) });
    expect(res.status).toBe(403);
  });
});

describe("groups API enterprise gate", () => {
  beforeEach(() => {
    // Admin passes, but enterprise is disabled
    (requireAdmin as any).mockResolvedValue(adminSession);
    (isEnterprise as any).mockResolvedValue(false);
  });

  it("GET /api/groups returns 403 without enterprise", async () => {
    const { GET } = await import("@/app/api/groups/route");
    const res = await GET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Enterprise feature");
  });

  it("POST /api/groups returns 403 without enterprise", async () => {
    const { POST } = await import("@/app/api/groups/route");
    const req = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ name: "Test" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req as any);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Enterprise feature");
  });

  it("PATCH /api/groups/:id returns 403 without enterprise", async () => {
    const { PATCH } = await import("@/app/api/groups/[groupId]/route");
    const req = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({ name: "Test" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req as any, { params: Promise.resolve({ groupId: "g1" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Enterprise feature");
  });

  it("DELETE /api/groups/:id returns 403 without enterprise", async () => {
    const { DELETE } = await import("@/app/api/groups/[groupId]/route");
    const req = new Request("http://localhost", { method: "DELETE" });
    const res = await DELETE(req as any, { params: Promise.resolve({ groupId: "g1" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Enterprise feature");
  });

  it("GET /api/groups/:id/members returns 403 without enterprise", async () => {
    const { GET } = await import("@/app/api/groups/[groupId]/members/route");
    const req = new Request("http://localhost", { method: "GET" });
    const res = await GET(req as any, { params: Promise.resolve({ groupId: "g1" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Enterprise feature");
  });

  it("PUT /api/groups/:id/members returns 403 without enterprise", async () => {
    const { PUT } = await import("@/app/api/groups/[groupId]/members/route");
    const req = new Request("http://localhost", {
      method: "PUT",
      body: JSON.stringify({ userIds: [] }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req as any, { params: Promise.resolve({ groupId: "g1" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Enterprise feature");
  });
});
