import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              id: "conn-1",
              type: "odoo",
              credentials: "encrypted-blob",
            },
          ]),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: vi.fn().mockReturnValue('{"accessToken":"test-token","refreshToken":"test-refresh"}'),
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { decrypt } from "@/lib/encryption";
import { GET } from "@/app/api/internal/integrations/[connectionId]/credentials/route";

function makeRequest(connectionId: string) {
  return new NextRequest(`http://localhost/api/internal/integrations/${connectionId}/credentials`, {
    method: "GET",
    headers: {
      Authorization: "Bearer test-token",
    },
  });
}

function makeParams(connectionId: string) {
  return { params: Promise.resolve({ connectionId }) };
}

function mockDbSelectResult(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as any);
}

describe("GET /api/internal/integrations/:connectionId/credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    vi.mocked(decrypt).mockReturnValue(
      '{"accessToken":"test-token","refreshToken":"test-refresh"}'
    );
    mockDbSelectResult([
      {
        id: "conn-1",
        type: "odoo",
        credentials: "encrypted-blob",
      },
    ]);
  });

  it("returns 401 without valid gateway token", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(false);

    const res = await GET(makeRequest("conn-1"), makeParams("conn-1"));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("returns 404 for non-existent connection", async () => {
    mockDbSelectResult([]);

    const res = await GET(makeRequest("non-existent"), makeParams("non-existent"));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Connection not found");
  });

  it("returns 500 when decryption fails", async () => {
    vi.mocked(decrypt).mockImplementation(() => {
      throw new Error("Decryption failed");
    });

    const res = await GET(makeRequest("conn-1"), makeParams("conn-1"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Failed to decrypt credentials");
  });

  it("returns 200 with decrypted credentials for valid connection", async () => {
    const res = await GET(makeRequest("conn-1"), makeParams("conn-1"));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.type).toBe("odoo");
    expect(data.credentials).toEqual({
      accessToken: "test-token",
      refreshToken: "test-refresh",
    });
    expect(decrypt).toHaveBeenCalledWith("encrypted-blob");
  });
});
