import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn();
  return {
    getSession: mockGetSession,
    auth: { api: { getSession: mockGetSession } },
  };
});

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          provider: "anthropic",
          modelId: "claude-opus-4-7",
          vision: true,
          documents: true,
          audio: false,
          video: false,
          longContext: true,
          tools: true,
        },
      ]),
    }),
  },
}));

import { GET } from "@/app/api/models/capabilities/route";
import { getSession } from "@/lib/auth";

const mockReq = () => new NextRequest("http://localhost/api/models/capabilities");

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({ user: { id: "u1" } } as never);
});

it("returns capability map keyed by qualified model id", async () => {
  const res = await GET(mockReq(), {} as never);
  const json = await res.json();
  expect(json["anthropic/claude-opus-4-7"]).toEqual({
    vision: true,
    documents: true,
    audio: false,
    video: false,
    longContext: true,
    tools: true,
  });
});

it("returns 401 when no session", async () => {
  vi.mocked(getSession).mockResolvedValueOnce(null);
  const res = await GET(mockReq(), {} as never);
  expect(res.status).toBe(401);
});
