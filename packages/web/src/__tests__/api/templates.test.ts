import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "1", email: "admin@test.com" } }),
}));

import { GET } from "@/app/api/templates/route";
import { auth } from "@/lib/auth";

describe("GET /api/templates", () => {
  it("should return available templates", async () => {
    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);
    const body = await response.json();

    expect(body.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "knowledge-base",
          name: "Knowledge Base",
          description: "Answer questions from your docs",
          requiresDirectories: true,
          defaultTagline: "Answer questions from your docs",
        }),
        expect.objectContaining({
          id: "custom",
          name: "Custom Agent",
          description: "Start from scratch",
          requiresDirectories: false,
          defaultTagline: null,
        }),
      ])
    );
  });

  it("should return 401 without auth", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/templates");
    const response = await GET(request);

    expect(response.status).toBe(401);
  });
});
