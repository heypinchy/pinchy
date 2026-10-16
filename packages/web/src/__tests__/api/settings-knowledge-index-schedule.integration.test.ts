// GET/PUT /api/settings/knowledge-index-schedule — the admin's control over
// the nightly knowledge-base reindex.
//
// Against a real database, because the answer the route gives is computed from
// three settings rows (the schedule, the org timezone, the scheduler's state)
// and the point is that it reads the same rows the scheduler acts on.
//
// What stays mocked, and why:
//   - @/lib/auth / next/headers — no browser session exists in a test process.
//   - appendAuditLog — so the audit call is asserted as a call: its from/to
//     detail is the contract here, and the audit chain itself is covered
//     elsewhere.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { mockSession } from "@/test-helpers/auth";
import { setSetting } from "@/lib/settings";
import { getIndexSchedule, saveIndexScheduleState } from "@/lib/knowledge/index-schedule-store";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockAppendAuditLog = vi.fn();
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
}));

const { GET, PUT } = await import("@/app/api/settings/knowledge-index-schedule/route");

const URL = "http://localhost/api/settings/knowledge-index-schedule";
const ctx = { params: Promise.resolve({}) };

function putRequest(body: unknown) {
  return new NextRequest(URL, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const admin = mockSession({ user: { id: "admin-1", role: "admin" } });
const member = mockSession({ user: { id: "member-1", role: "member" } });

beforeEach(async () => {
  mockGetSession.mockResolvedValue(admin);
  mockAppendAuditLog.mockReset();
  await setSetting("org.timezone", "Europe/Vienna");
  // Only Date is faked: the database driver's own timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  // 22:00 in Vienna on 16 Oct (CEST, UTC+2).
  vi.setSystemTime(new Date("2026-10-16T20:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/settings/knowledge-index-schedule", () => {
  it("reports the default — on, nightly at 02:00 in the org timezone — before anything was saved", async () => {
    const res = await GET(new NextRequest(URL), ctx as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      time: "02:00",
      timezone: "Europe/Vienna",
      nextRun: { date: "2026-10-17", time: "02:00", day: "tomorrow" },
      currentSweep: null,
      lastSweep: null,
    });
  });

  // What the admin wants to know about the night: did it run, for how many
  // agents, and is it still going.
  it("reports the sweep in progress and the last one that finished queueing", async () => {
    await saveIndexScheduleState({
      lastSlot: "2026-10-16",
      schedule: { enabled: true, time: "02:00" },
      timezone: "Europe/Vienna",
      sweep: {
        id: "sweep-2",
        slot: "2026-10-16",
        startedAt: "2026-10-16T00:00:00.000Z",
        agentCount: 3,
        pending: ["agent-b", "agent-c"],
      },
      lastSweep: {
        id: "sweep-1",
        slot: "2026-10-15",
        startedAt: "2026-10-15T00:00:00.000Z",
        agentCount: 3,
      },
    });

    const body = await (await GET(new NextRequest(URL), ctx as never)).json();

    expect(body.currentSweep).toEqual({
      slot: "2026-10-16",
      startedAt: "2026-10-16T00:00:00.000Z",
      agentCount: 3,
      waiting: 2,
    });
    expect(body.lastSweep).toEqual({
      slot: "2026-10-15",
      startedAt: "2026-10-15T00:00:00.000Z",
      agentCount: 3,
    });
  });

  it("is admin-only", async () => {
    mockGetSession.mockResolvedValue(member);
    const res = await GET(new NextRequest(URL), ctx as never);
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/settings/knowledge-index-schedule", () => {
  it("saves the schedule and answers with what will happen next", async () => {
    const res = await PUT(putRequest({ enabled: true, time: "23:30" }), ctx as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: true,
      time: "23:30",
      timezone: "Europe/Vienna",
      nextRun: { date: "2026-10-16", time: "23:30", day: "today" },
    });
    expect(await getIndexSchedule()).toEqual({ enabled: true, time: "23:30" });
  });

  it("switches the nightly run off", async () => {
    const res = await PUT(putRequest({ enabled: false, time: "02:00" }), ctx as never);

    expect(await res.json()).toMatchObject({ enabled: false, nextRun: null });
    expect(await getIndexSchedule()).toEqual({ enabled: false, time: "02:00" });
  });

  // Turning the nightly run off decides whether new documents ever become
  // searchable on their own — the trail has to say who decided it, and what
  // it was before.
  it("audits the change with what it was and what it became", async () => {
    await PUT(putRequest({ enabled: false, time: "02:00" }), ctx as never);

    expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
    expect(mockAppendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "settings.updated",
      resource: "settings:knowledge_index_schedule",
      detail: {
        changes: {
          knowledgeIndexSchedule: {
            from: { enabled: true, time: "02:00" },
            to: { enabled: false, time: "02:00" },
          },
        },
      },
      outcome: "success",
    });
  });

  it("writes no audit row for a save that changed nothing", async () => {
    await PUT(putRequest({ enabled: true, time: "02:00" }), ctx as never);
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ["an hour past 23", { enabled: true, time: "24:00" }],
    ["a time without its leading zero", { enabled: true, time: "2:00" }],
    ["seconds", { enabled: true, time: "02:00:00" }],
    ["no on/off", { time: "02:00" }],
  ])("rejects %s with a 400 and saves nothing", async (_label, body) => {
    const res = await PUT(putRequest(body), ctx as never);

    expect(res.status).toBe(400);
    expect(await getIndexSchedule()).toEqual({ enabled: true, time: "02:00" });
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("is admin-only, and a refused request saves nothing", async () => {
    mockGetSession.mockResolvedValue(member);

    const res = await PUT(putRequest({ enabled: false, time: "02:00" }), ctx as never);

    expect(res.status).toBe(403);
    expect(await getIndexSchedule()).toEqual({ enabled: true, time: "02:00" });
  });
});
