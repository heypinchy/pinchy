import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock postgres-js so importing db/index doesn't open a real connection.
const { endMock, postgresMock, drizzleMock } = vi.hoisted(() => {
  const endMock = vi.fn().mockResolvedValue(undefined);
  const postgresMock = vi.fn(() => ({ end: endMock }));
  const drizzleMock = vi.fn((client: unknown, opts: unknown) => ({ client, opts }));
  return { endMock, postgresMock, drizzleMock };
});
vi.mock("postgres", () => ({ default: postgresMock }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: drizzleMock }));

import { closeDb } from "@/db";

describe("db client pool + closeDb (#263)", () => {
  beforeEach(() => {
    // Don't clear postgresMock — its import-time call records the pool config.
    endMock.mockClear();
  });

  it("configures an explicit pool (max/idle_timeout/connect_timeout)", () => {
    expect(postgresMock).toHaveBeenCalledTimes(1);
    const [, options] = postgresMock.mock.calls[0];
    expect(options).toMatchObject({ max: 20, idle_timeout: 30, connect_timeout: 10 });
  });

  it("closeDb ends the pool with a 5s timeout", async () => {
    await closeDb();
    expect(endMock).toHaveBeenCalledWith({ timeout: 5 });
  });
});
