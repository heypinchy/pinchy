import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

const mockVerifyIntegrity = vi.fn();
vi.mock("@/lib/audit", () => ({
  verifyIntegrity: mockVerifyIntegrity,
}));

import { requireAdmin } from "@/lib/api-auth";

describe("GET /api/audit/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as Awaited<ReturnType<typeof requireAdmin>>);
  });

  it("should return 403 for non-admin users", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const { GET } = await import("@/app/api/audit/verify/route");
    const request = new Request("http://localhost/api/audit/verify");
    const response = await GET(request as any);
    expect(response.status).toBe(403);
  });

  it("should return verification result with all entries valid", async () => {
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 10,
      invalidIds: [],
    });

    const { GET } = await import("@/app/api/audit/verify/route");
    const request = new Request("http://localhost/api/audit/verify");
    const response = await GET(request as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.totalChecked).toBe(10);
    expect(body.invalidIds).toEqual([]);
  });

  it("should return invalid IDs when entries are tampered", async () => {
    mockVerifyIntegrity.mockResolvedValue({
      valid: false,
      totalChecked: 10,
      invalidIds: [3, 7],
    });

    const { GET } = await import("@/app/api/audit/verify/route");
    const request = new Request("http://localhost/api/audit/verify");
    const response = await GET(request as any);
    const body = await response.json();

    expect(body.valid).toBe(false);
    expect(body.invalidIds).toEqual([3, 7]);
  });

  it("should pass fromId and toId parameters to verifyIntegrity", async () => {
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 5,
      invalidIds: [],
    });

    const { GET } = await import("@/app/api/audit/verify/route");
    const request = new Request("http://localhost/api/audit/verify?fromId=10&toId=20");
    const response = await GET(request as any);

    expect(response.status).toBe(200);
    expect(mockVerifyIntegrity).toHaveBeenCalledWith(10, 20);
  });

  it("returns 400 for a non-numeric fromId instead of crashing (NaN into SQL)", async () => {
    const { GET } = await import("@/app/api/audit/verify/route");
    const request = new Request("http://localhost/api/audit/verify?fromId=abc");
    const response = await GET(request as any);

    expect(response.status).toBe(400);
    expect(mockVerifyIntegrity).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric toId", async () => {
    const { GET } = await import("@/app/api/audit/verify/route");
    const request = new Request("http://localhost/api/audit/verify?toId=xyz");
    const response = await GET(request as any);

    expect(response.status).toBe(400);
  });

  it("should call verifyIntegrity without params when none provided", async () => {
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 0,
      invalidIds: [],
    });

    const { GET } = await import("@/app/api/audit/verify/route");
    const request = new Request("http://localhost/api/audit/verify");
    await GET(request as any);

    expect(mockVerifyIntegrity).toHaveBeenCalledWith(undefined, undefined);
  });
});
