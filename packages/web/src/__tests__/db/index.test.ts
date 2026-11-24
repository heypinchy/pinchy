import { describe, it, expect, vi } from "vitest";

// Mock postgres-js so importing db/index doesn't open a real connection.
const { endMock, postgresMock, drizzleMock } = vi.hoisted(() => {
  const endMock = vi.fn().mockResolvedValue(undefined);
  // Real `postgres(connectionString, options)` takes two args; declaring both
  // params here (even though the fake body ignores them) keeps
  // `postgresMock.mock.calls[0]` a 2-element tuple so the test can read back
  // the options object passed at import time.
  const postgresMock = vi.fn((_connectionString: string, _options: unknown) => ({ end: endMock }));
  const drizzleMock = vi.fn((client: unknown, opts: unknown) => ({ client, opts }));
  return { endMock, postgresMock, drizzleMock };
});
vi.mock("postgres", () => ({ default: postgresMock }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: drizzleMock }));

import { closeDb } from "@/db";

// postgres() runs once, when @/db is imported above. Vitest clears every
// mock's call history before each test (`clearMocks` defaults to true), so the
// import-time call is captured here, before the first test runs.
const postgresImportCalls = [...postgresMock.mock.calls];

describe("db client pool + closeDb (#263)", () => {
  it("configures an explicit pool (max/idle_timeout/connect_timeout)", () => {
    expect(postgresImportCalls).toHaveLength(1);
    const [, options] = postgresImportCalls[0];
    expect(options).toMatchObject({ max: 20, idle_timeout: 30, connect_timeout: 10 });
  });

  it("closeDb ends the pool with a 5s timeout", async () => {
    await closeDb();
    expect(endMock).toHaveBeenCalledWith({ timeout: 5 });
  });
});
