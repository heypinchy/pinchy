// Real-DB integration test for POST /api/diagnostics/export.
//
// What stays mocked, and why:
//   - @/lib/diagnostics/jsonl-reader — the OpenClaw shared-volume layout lives
//     outside the Pinchy container in tests. The reader has its own unit
//     coverage; here we hand the route deterministic trajectory bytes.
//   - @/lib/auth — getSession would otherwise require Better Auth cookies on
//     the NextRequest. We seed the user in the DB and inject the session
//     object directly.
//
// Everything else (Drizzle agent lookup, agent-access enforcement, audit
// writes via appendAuditLog -> auditLog table) runs for real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { and, eq, desc } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE = readFileSync(
  join(__dirname, "../lib/diagnostics/fixtures/sample-session.trajectory.jsonl"),
  "utf8"
);

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

// `after()` from next/server requires a real request scope. The route
// schedules its audit write via deferAuditLog -> after(), so we run the
// callback synchronously in tests to keep audit-row assertions deterministic.
// Mirrors src/test-setup.ts (which only applies to the unit suite).
//
// Because the callback is itself async (appendAuditLog writes via Drizzle),
// we track in-flight promises so the test body can `await flushAfter()` before
// querying the DB.
const pendingAfter: Promise<unknown>[] = [];
async function flushAfter(): Promise<void> {
  while (pendingAfter.length > 0) {
    const all = pendingAfter.splice(0);
    await Promise.allSettled(all);
  }
}
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((fn: () => void | Promise<void>) => {
      try {
        const result = fn();
        if (result instanceof Promise) {
          // Track so tests can await completion. .catch swallows to match
          // Next's after() error handling (errors stay inside after()).
          pendingAfter.push(result.catch(() => {}));
        }
      } catch {
        // Swallowed — matches Next's after() error handling.
      }
    }),
  };
});

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession: vi.fn() };
});

// Mock the FS-touching exports only; importActual preserves anything else the
// route imports (e.g. error classes) and keeps this resilient to new exports
// being added to the module without silently breaking tests.
vi.mock("@/lib/diagnostics/jsonl-reader", async () => {
  const actual = await vi.importActual<typeof import("@/lib/diagnostics/jsonl-reader")>(
    "@/lib/diagnostics/jsonl-reader"
  );
  return {
    ...actual,
    resolveSessionId: vi.fn(),
    readTrajectoryJsonl: vi.fn(),
  };
});

// The chat enumeration (#639 selector path) hits OpenClaw's sessions.list;
// mock it so tests can hand the route a deterministic, already-authorized set
// of the user's own chats. The default (no-selector) path never calls it.
vi.mock("@/lib/chats/list-user-agent-chats", () => ({
  listUserAgentChats: vi.fn(),
}));

import { createHash } from "node:crypto";
import { db } from "@/db";
import { agents, auditLog, users } from "@/db/schema";
import { auth } from "@/lib/auth";
import { getSession } from "@/lib/auth";
import { resolveSessionId, readTrajectoryJsonl } from "@/lib/diagnostics/jsonl-reader";
import { listUserAgentChats } from "@/lib/chats/list-user-agent-chats";
import { TrajectoryFileNotFoundError } from "@/lib/diagnostics/jsonl-reader";
import { POST } from "@/app/api/diagnostics/export/route";

function sessionKeyHash(key: string) {
  return "sha256:" + createHash("sha256").update(key).digest("hex");
}

async function seedUser(email = "user@test.local", role = "member") {
  const result = await auth.api.signUpEmail({
    body: { name: "Test User", email, password: "Br1ghtNova!2" },
  });
  if (role === "admin") {
    await db.update(users).set({ role: "admin" }).where(eq(users.id, result.user.id));
  }
  return { id: result.user.id, role };
}

async function seedPersonalAgent(ownerId: string, name = "Smithers") {
  const [row] = await db
    .insert(agents)
    .values({
      name,
      model: "ollama/qwen3",
      ownerId,
      isPersonal: true,
      greetingMessage: "Hi",
    })
    .returning();
  return row;
}

function mockSession(user: { id: string; role: string }) {
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "sess", userId: user.id } as never,
    user: {
      id: user.id,
      role: user.role,
      email: "x@x",
      name: "x",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      banned: false,
      banReason: null,
      banExpires: null,
    } as never,
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:7777/api/diagnostics/export", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/diagnostics/export (integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveSessionId).mockResolvedValue("ses_FIXTURE_SESSION_0001");
    vi.mocked(readTrajectoryJsonl).mockResolvedValue(FIXTURE);
  });

  it("returns 401 when there is no session", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const response = await POST(makeRequest({ agentId: "agt_x" }));
    expect(response.status).toBe(401);
  });

  it("returns 400 for an invalid body", async () => {
    const owner = await seedUser();
    mockSession(owner);
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation failed");
  });

  it("returns the bundle for the caller's own personal agent", async () => {
    const owner = await seedUser();
    mockSession(owner);
    const agent = await seedPersonalAgent(owner.id);

    const response = await POST(makeRequest({ agentId: agent.id }));
    expect(response.status).toBe(200);
    const bundle = await response.json();
    expect(bundle.schemaVersion).toBe("pinchy.bugreport.v1");
    expect(bundle.scope.agentId).toBe(agent.id);
    // sessionKey is hashed in the bundle, not echoed back verbatim.
    expect(bundle.scope.sessionKeyHash).toMatch(/^sha256:/);
    expect(Array.isArray(bundle.spans)).toBe(true);
    expect(Array.isArray(bundle.auditEntries)).toBe(true);
    // agentConfig snapshot (#642): configured model/provider, per-agent tool
    // allow-list, and an instructions HASH — never the raw prompt. The enriched
    // bundle still passes through sanitize + the 5 MB cap (it returned 200).
    expect(bundle.agentConfig.agent).toEqual({ id: agent.id, name: agent.name });
    expect(bundle.agentConfig.model).toBe("ollama/qwen3");
    expect(bundle.agentConfig.provider).toBe("ollama");
    expect(Array.isArray(bundle.agentConfig.allowedTools)).toBe(true);
    expect(bundle.agentConfig.instructionsHash["SOUL.md"]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(bundle.agentConfig.instructionsHash["AGENTS.md"]).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("denies access when the caller does not own the agent and is not admin", async () => {
    const owner = await seedUser("owner@test.local");
    const intruder = await seedUser("intruder@test.local");
    const agent = await seedPersonalAgent(owner.id);

    mockSession(intruder);

    const response = await POST(makeRequest({ agentId: agent.id }));
    // getAgentWithAccess returns 403 for personal agents owned by someone else.
    expect(response.status).toBe(403);
  });

  it("writes a diagnostics.exported audit entry on success", async () => {
    const owner = await seedUser();
    mockSession(owner);
    const agent = await seedPersonalAgent(owner.id);

    const response = await POST(
      makeRequest({ agentId: agent.id, userDescription: "Stuck on tool error" })
    );
    expect(response.status).toBe(200);
    await flushAfter();

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "diagnostics.exported"))
      .orderBy(desc(auditLog.timestamp));

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.actorId).toBe(owner.id);
    expect(row.outcome).toBe("success");
    expect(row.resource).toBe(`diagnostics:${agent.id}`);
    const detail = row.detail as Record<string, unknown>;
    expect(detail.agent).toMatchObject({ id: agent.id, name: agent.name });
    expect(typeof detail.byteSize).toBe("number");
    expect(typeof detail.droppedTurns).toBe("number");
    expect(typeof detail.truncated).toBe("boolean");
  });

  it("returns 404 when there is no recorded session for the user+agent", async () => {
    const owner = await seedUser();
    mockSession(owner);
    const agent = await seedPersonalAgent(owner.id);
    vi.mocked(resolveSessionId).mockResolvedValue(null);

    const response = await POST(makeRequest({ agentId: agent.id }));
    expect(response.status).toBe(404);
  });

  it("includes audit rows for the caller's interactions with the agent", async () => {
    const owner = await seedUser();
    mockSession(owner);
    const agent = await seedPersonalAgent(owner.id);

    // Seed audit rows with the REAL production shape (resource = agent:<id>,
    // actorId = the user) AND with a timestamp inside the fixture's turn
    // window so the audit-collector's time-range filter (added in the
    // diagnostics route to scope rows to the selected turn window) lets them
    // through. The fixture's first model.completed event is at
    // 2026-05-19T12:01:20Z, so anchoring at 2026-05-19T12:15:00Z lands the
    // rows comfortably inside the trajectory's time range.
    const auditTs = new Date("2026-05-19T12:15:00Z");
    await db.insert(auditLog).values([
      {
        actorType: "user",
        actorId: owner.id,
        eventType: "tool.pinchy_ls",
        resource: `agent:${agent.id}`,
        detail: { agentId: agent.id },
        outcome: "success",
        rowHmac: "test-placeholder-hmac",
        timestamp: auditTs,
      },
      {
        actorType: "user",
        actorId: owner.id,
        eventType: "tool.pinchy_read",
        resource: `agent:${agent.id}`,
        detail: { agentId: agent.id, path: "/x" },
        outcome: "success",
        rowHmac: "test-placeholder-hmac",
        timestamp: auditTs,
      },
    ]);

    const response = await POST(makeRequest({ agentId: agent.id }));
    expect(response.status).toBe(200);
    const bundle = await response.json();
    const toolEntries = (bundle.auditEntries as Array<{ eventType: string }>).filter((e) =>
      e.eventType.startsWith("tool.")
    );
    expect(toolEntries).toHaveLength(2);
    const eventTypes = toolEntries.map((e) => e.eventType).sort();
    expect(eventTypes).toEqual(["tool.pinchy_ls", "tool.pinchy_read"]);
  });

  it("returns an empty-spans bundle when the trajectory file is empty", async () => {
    const owner = await seedUser();
    mockSession(owner);
    const agent = await seedPersonalAgent(owner.id);
    vi.mocked(readTrajectoryJsonl).mockResolvedValue("");

    const response = await POST(makeRequest({ agentId: agent.id }));
    expect(response.status).toBe(200);
    const bundle = await response.json();
    expect(bundle.spans).toEqual([]);
    expect(bundle.scope.includedTurnRange).toEqual([0, -1]);
  });

  // ── #639: per-chat + Telegram selector, graceful degrade ─────────────────

  describe("sessionId selector (#639)", () => {
    it("resolves the SELECTED named chat's trajectory, not the default", async () => {
      const owner = await seedUser();
      mockSession(owner);
      const agent = await seedPersonalAgent(owner.id);

      const namedKey = `agent:${agent.id}:direct:${owner.id}:chat-new`;
      vi.mocked(listUserAgentChats).mockResolvedValue({
        chats: [
          {
            sessionId: "s-legacy",
            key: `agent:${agent.id}:direct:${owner.id}`,
            origin: "web",
            writable: true,
            chatId: null,
            lastInteractionAt: 1000,
          },
          {
            sessionId: "s-named",
            key: namedKey,
            origin: "web",
            writable: true,
            chatId: "chat-new",
            lastInteractionAt: 5000,
          },
        ],
        labelByKey: new Map(),
      });
      // Fail loudly if the route ever falls back to resolveSessionId here.
      vi.mocked(resolveSessionId).mockResolvedValue("s-legacy");
      vi.mocked(readTrajectoryJsonl).mockResolvedValue(FIXTURE);

      const response = await POST(makeRequest({ agentId: agent.id, sessionId: "s-named" }));
      expect(response.status).toBe(200);
      const bundle = await response.json();

      // The trajectory was read for the NAMED session, and the bundle's
      // hashed key is the named chat's key — not the default.
      expect(vi.mocked(readTrajectoryJsonl)).toHaveBeenCalledWith(agent.id, "s-named");
      expect(bundle.scope.sessionKeyHash).toBe(sessionKeyHash(namedKey));
      expect(vi.mocked(resolveSessionId)).not.toHaveBeenCalled();
    });

    it("exports a linked Telegram chat selected by sessionId", async () => {
      const owner = await seedUser();
      mockSession(owner);
      const agent = await seedPersonalAgent(owner.id);

      const tgKey = `agent:${agent.id}:direct:tg-peer-1`;
      vi.mocked(listUserAgentChats).mockResolvedValue({
        chats: [
          {
            sessionId: "s-tg",
            key: tgKey,
            origin: "telegram",
            writable: false,
            chatId: null,
            lastInteractionAt: 3000,
          },
        ],
        labelByKey: new Map(),
      });
      vi.mocked(readTrajectoryJsonl).mockResolvedValue(FIXTURE);

      const response = await POST(makeRequest({ agentId: agent.id, sessionId: "s-tg" }));
      expect(response.status).toBe(200);
      const bundle = await response.json();
      expect(vi.mocked(readTrajectoryJsonl)).toHaveBeenCalledWith(agent.id, "s-tg");
      expect(bundle.scope.sessionKeyHash).toBe(sessionKeyHash(tgKey));
    });

    it("returns 404 when the selected sessionId is not one of the user's chats", async () => {
      const owner = await seedUser();
      mockSession(owner);
      const agent = await seedPersonalAgent(owner.id);
      vi.mocked(listUserAgentChats).mockResolvedValue({ chats: [], labelByKey: new Map() });

      const response = await POST(makeRequest({ agentId: agent.id, sessionId: "s-someone-else" }));
      expect(response.status).toBe(404);
      expect(vi.mocked(readTrajectoryJsonl)).not.toHaveBeenCalled();
    });

    it("degrades to trajectoryMissing=true (not 404) when the selected chat's trajectory file is gone", async () => {
      const owner = await seedUser();
      mockSession(owner);
      const agent = await seedPersonalAgent(owner.id);

      vi.mocked(listUserAgentChats).mockResolvedValue({
        chats: [
          {
            sessionId: "s-named",
            key: `agent:${agent.id}:direct:${owner.id}:chat-new`,
            origin: "web",
            writable: true,
            chatId: "chat-new",
            lastInteractionAt: 5000,
          },
        ],
        labelByKey: new Map(),
      });
      vi.mocked(readTrajectoryJsonl).mockRejectedValue(
        new TrajectoryFileNotFoundError("/gone.jsonl")
      );

      // An audit row for this user+agent must still make it into the bundle.
      await db.insert(auditLog).values({
        actorType: "user",
        actorId: owner.id,
        eventType: "tool.pinchy_ls",
        resource: `agent:${agent.id}`,
        detail: { agentId: agent.id },
        outcome: "success",
        rowHmac: "test-placeholder-hmac",
        timestamp: new Date("2026-05-19T12:15:00Z"),
      });

      const response = await POST(makeRequest({ agentId: agent.id, sessionId: "s-named" }));
      expect(response.status).toBe(200);
      const bundle = await response.json();
      expect(bundle.scope.trajectoryMissing).toBe(true);
      expect(bundle.spans).toEqual([]);
      const toolEntries = (bundle.auditEntries as Array<{ eventType: string }>).filter((e) =>
        e.eventType.startsWith("tool.")
      );
      expect(toolEntries).toHaveLength(1);
    });

    it("degrades the DEFAULT chat too when its trajectory file is gone (was 404)", async () => {
      const owner = await seedUser();
      mockSession(owner);
      const agent = await seedPersonalAgent(owner.id);
      vi.mocked(resolveSessionId).mockResolvedValue("ses_default");
      vi.mocked(readTrajectoryJsonl).mockRejectedValue(
        new TrajectoryFileNotFoundError("/gone.jsonl")
      );

      const response = await POST(makeRequest({ agentId: agent.id }));
      expect(response.status).toBe(200);
      const bundle = await response.json();
      expect(bundle.scope.trajectoryMissing).toBe(true);
    });

    it("records the exported chatId and trajectoryMissing in the audit entry", async () => {
      const owner = await seedUser();
      mockSession(owner);
      const agent = await seedPersonalAgent(owner.id);

      vi.mocked(listUserAgentChats).mockResolvedValue({
        chats: [
          {
            sessionId: "s-named",
            key: `agent:${agent.id}:direct:${owner.id}:chat-new`,
            origin: "web",
            writable: true,
            chatId: "chat-new",
            lastInteractionAt: 5000,
          },
        ],
        labelByKey: new Map(),
      });
      vi.mocked(readTrajectoryJsonl).mockResolvedValue(FIXTURE);

      const response = await POST(makeRequest({ agentId: agent.id, sessionId: "s-named" }));
      expect(response.status).toBe(200);
      await flushAfter();

      // Scope to THIS test's actor: prior successful exports in this block
      // schedule their audit writes via after() without flushing, and those
      // can land after this test's beforeEach truncate. Each test seeds a fresh
      // user, so filtering by actorId isolates the row we asserted on.
      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.eventType, "diagnostics.exported"), eq(auditLog.actorId, owner.id)))
        .orderBy(desc(auditLog.timestamp));
      expect(rows).toHaveLength(1);
      const detail = rows[0].detail as Record<string, unknown>;
      expect(detail.chatId).toBe("chat-new");
      expect(detail.trajectoryMissing).toBe(false);
    });

    it("exports BOTH a pre-#508 default-only session AND a new per-chat session (migration)", async () => {
      const owner = await seedUser();
      mockSession(owner);
      const agent = await seedPersonalAgent(owner.id);

      const legacyKey = `agent:${agent.id}:direct:${owner.id}`;
      const namedKey = `agent:${agent.id}:direct:${owner.id}:chat-new`;
      // Same index carries the OLD default-only chat and the NEW per-chat one.
      vi.mocked(listUserAgentChats).mockResolvedValue({
        chats: [
          {
            sessionId: "s-legacy",
            key: legacyKey,
            origin: "web",
            writable: true,
            chatId: null,
            lastInteractionAt: 1000,
          },
          {
            sessionId: "s-named",
            key: namedKey,
            origin: "web",
            writable: true,
            chatId: "chat-new",
            lastInteractionAt: 5000,
          },
        ],
        labelByKey: new Map(),
      });
      vi.mocked(readTrajectoryJsonl).mockResolvedValue(FIXTURE);

      const legacyRes = await POST(makeRequest({ agentId: agent.id, sessionId: "s-legacy" }));
      expect(legacyRes.status).toBe(200);
      expect((await legacyRes.json()).scope.sessionKeyHash).toBe(sessionKeyHash(legacyKey));

      const namedRes = await POST(makeRequest({ agentId: agent.id, sessionId: "s-named" }));
      expect(namedRes.status).toBe(200);
      expect((await namedRes.json()).scope.sessionKeyHash).toBe(sessionKeyHash(namedKey));
    });
  });
});
