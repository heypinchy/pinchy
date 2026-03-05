import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSql, mockLogCapture, mockGetSession } = vi.hoisted(() => ({
  mockDb: { execute: vi.fn() },
  mockSql: vi.fn(),
  mockLogCapture: { formatAsText: vi.fn().mockReturnValue("") },
  mockGetSession: vi.fn(),
}));

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("drizzle-orm", () => ({ sql: mockSql }));
vi.mock("@/lib/log-capture", () => ({ logCapture: mockLogCapture }));
vi.mock("@/lib/auth", () => ({ getSession: mockGetSession }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

import { GET } from "@/app/api/diagnostics/route";

describe("GET /api/diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_WS_URL = "ws://localhost:18789";
  });

  it("should return database status as connected when DB query succeeds", async () => {
    mockDb.execute.mockResolvedValueOnce([{ "?column?": 1 }]);
    vi.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true } as Response);

    const response = await GET();
    const data = await response.json();

    expect(data.database).toBe("connected");
  });

  it("should return database status as unreachable when DB query fails", async () => {
    mockDb.execute.mockRejectedValueOnce(new Error("Connection refused"));
    vi.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true } as Response);

    const response = await GET();
    const data = await response.json();

    expect(data.database).toBe("unreachable");
  });

  it("should return openclaw status as connected when HTTP check succeeds", async () => {
    mockDb.execute.mockResolvedValueOnce([{ "?column?": 1 }]);
    vi.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true } as Response);

    const response = await GET();
    const data = await response.json();

    expect(data.openclaw).toBe("connected");
  });

  it("should return openclaw status as unreachable when HTTP check fails", async () => {
    mockDb.execute.mockResolvedValueOnce([{ "?column?": 1 }]);
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("Connection refused"));

    const response = await GET();
    const data = await response.json();

    expect(data.openclaw).toBe("unreachable");
  });

  it("should return version and nodeEnv", async () => {
    mockDb.execute.mockResolvedValueOnce([{ "?column?": 1 }]);
    vi.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true } as Response);

    const response = await GET();
    const data = await response.json();

    expect(data).toHaveProperty("version");
    expect(data).toHaveProperty("nodeEnv");
  });

  it("should return openclaw as unreachable when OPENCLAW_WS_URL is not set", async () => {
    delete process.env.OPENCLAW_WS_URL;
    mockDb.execute.mockResolvedValueOnce([{ "?column?": 1 }]);

    const response = await GET();
    const data = await response.json();

    expect(data.openclaw).toBe("unreachable");
  });

  it("should include captured logs when user is authenticated", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "1" } });
    mockDb.execute.mockResolvedValueOnce([{ "?column?": 1 }]);
    vi.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true } as Response);
    mockLogCapture.formatAsText.mockReturnValueOnce(
      "2026-03-04T08:00:00Z [ERROR] DB connection failed"
    );

    const response = await GET();
    const data = await response.json();

    expect(data.logs).toBe("2026-03-04T08:00:00Z [ERROR] DB connection failed");
  });

  it("should omit logs when user is not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    mockDb.execute.mockResolvedValueOnce([{ "?column?": 1 }]);
    vi.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true } as Response);
    mockLogCapture.formatAsText.mockReturnValueOnce(
      "2026-03-04T08:00:00Z [ERROR] DB connection failed"
    );

    const response = await GET();
    const data = await response.json();

    expect(data).not.toHaveProperty("logs");
  });
});
