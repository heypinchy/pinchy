// Deactivating a user ends the chats they have open.
//
// server.ts authenticates a browser WebSocket once, at the upgrade, and
// ClientRouter never asked again. DELETE /api/users/:id banned the account and
// deleted its session rows — which stops the next upgrade — while a tab that
// was already open kept chatting, and kept having agents run tools on its
// behalf. This runs the real route against the real DB with a real socket
// registered the way server.ts registers it, then sends a frame the way a
// still-open tab would. Only the session, after() and the OpenClaw side
// effects (config regeneration, Telegram allow stores, workspace cleanup) are
// faked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "net";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((fn: () => unknown) => {
      void Promise.resolve()
        .then(fn)
        .catch(() => {});
    }),
  };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession: vi.fn() };
});
vi.mock("@/lib/openclaw-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-config")>();
  return { ...actual, regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/telegram-allow-store", () => ({
  recalculateTelegramAllowStores: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace")>();
  return { ...actual, deleteWorkspace: vi.fn().mockResolvedValue(undefined) };
});

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { users, auditLog } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { mockSession } from "@/test-helpers/auth";
import { DELETE } from "@/app/api/users/[userId]/route";
import { POST as REACTIVATE } from "@/app/api/users/[userId]/reactivate/route";
import { ClientRouter } from "@/server/client-router";
import { SessionCache } from "@/server/session-cache";
import { getUserSocketRegistry, ACCOUNT_DEACTIVATED_CLOSE_CODE } from "@/server/user-sockets";
import { getActiveRunsSingleton } from "@/server/active-runs-singleton";
import { setOpenClawClient } from "@/server/openclaw-client";
import { directSessionKey } from "@/lib/session-key";

let seq = 0;
async function insertUser(name: string, role: "admin" | "member") {
  seq++;
  const [row] = await db
    .insert(users)
    .values({ name, email: `${name.toLowerCase().replace(/\s+/g, "-")}-${seq}@test.local`, role })
    .returning();
  return row;
}

let wss: WebSocketServer | null = null;

/** A browser tab with an open chat socket, registered as server.ts does. */
async function openChat(userId: string) {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss!.once("listening", () => resolve()));
  wss.on("connection", (ws) => getUserSocketRegistry().register(userId, ws));
  const tab = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
  const frames: unknown[] = [];
  tab.on("message", (data) => frames.push(JSON.parse(data.toString())));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    tab.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  await new Promise<void>((resolve, reject) => {
    tab.once("open", () => resolve());
    tab.once("error", reject);
  });
  for (let i = 0; i < 200 && getUserSocketRegistry().openSocketCount(userId) === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const serverSide = [...wss.clients][0];
  return { tab, closed, frames, serverSide };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | "still open"> {
  return Promise.race([
    promise,
    new Promise<"still open">((r) => setTimeout(() => r("still open"), ms)),
  ]);
}

function asAdmin(admin: { id: string; name: string; email: string }) {
  vi.mocked(getSession).mockResolvedValue(
    mockSession({ user: { id: admin.id, name: admin.name, email: admin.email, role: "admin" } })
  );
}

function deactivate(userId: string) {
  return DELETE(new NextRequest(`http://localhost/api/users/${userId}`, { method: "DELETE" }), {
    params: Promise.resolve({ userId }),
  });
}

function fakeOpenClaw() {
  return {
    chat: vi.fn(),
    sessions: { history: vi.fn(), list: vi.fn() },
    isConnected: true,
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

describe("DELETE /api/users/:id with the user's chat open", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    if (wss) {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss!.close(() => r(undefined)));
      wss = null;
    }
  });

  it("closes the open chat and refuses what the tab still sends", async () => {
    const admin = await insertUser("Admin", "admin");
    const member = await insertUser("Leaving Member", "member");
    asAdmin(admin);
    const { closed } = await openChat(member.id);

    const res = await deactivate(member.id);
    expect(res.status).toBe(200);

    expect(await within(closed, 2000)).toEqual({
      code: ACCOUNT_DEACTIVATED_CLOSE_CODE,
      reason: "Account deactivated",
    });

    // A frame that was already on its way when the socket closed.
    const openclaw = fakeOpenClaw();
    const router = new ClientRouter(openclaw as never, member.id, "member", new SessionCache());
    const sent: string[] = [];
    const lateSocket = { readyState: 1, send: (d: string) => sent.push(d), close: vi.fn() };
    await router.handleMessage(
      lateSocket as never,
      {
        type: "message",
        content: "Export every customer record",
        agentId: "any-agent",
      } as never
    );

    expect(openclaw.chat).not.toHaveBeenCalled();
    expect(sent.map((s) => JSON.parse(s))).toEqual([
      {
        type: "error",
        code: "policy_account_deactivated",
        message: "Your account has been deactivated.",
      },
    ]);
  });

  it("stops a reply that is still running, so the agent runs no further tool for them", async () => {
    // Closing the socket only detaches it from the run: OpenClaw keeps
    // executing a run it accepted — odoo_write, email_send — until it ends on
    // its own. Deactivation has to abort it, the way the stop button does.
    const admin = await insertUser("Admin", "admin");
    const member = await insertUser("Leaving Member", "member");
    const colleague = await insertUser("Staying Member", "member");
    asAdmin(admin);
    const { closed, frames, serverSide } = await openChat(member.id);

    const runs = getActiveRunsSingleton();
    const leaving = directSessionKey("agent-ops", member.id);
    const staying = directSessionKey("agent-ops", colleague.id);
    runs.registerPending({
      runId: "provisional-1",
      sessionKey: leaving,
      agentId: "agent-ops",
      userId: member.id,
      agentName: "Ops Agent",
      submittedAt: Date.now(),
      currentMessageId: "msg-1",
      ws: serverSide as never,
    });
    // Already streaming: the gateway issued its own runId.
    runs.markFirstChunk(leaving, Date.now(), "gateway-run-1");
    runs.registerPending({
      runId: "provisional-2",
      sessionKey: staying,
      agentId: "agent-ops",
      userId: colleague.id,
      agentName: "Ops Agent",
      submittedAt: Date.now(),
      currentMessageId: "msg-2",
      ws: serverSide as never,
    });
    const chatAbort = vi.fn().mockResolvedValue({ ok: true, aborted: true, runIds: [] });
    setOpenClawClient({ ...fakeOpenClaw(), chatAbort } as never);

    try {
      const res = await deactivate(member.id);
      expect(res.status).toBe(200);

      // Aborted by the response, named by the gateway's runId, and only theirs.
      expect(chatAbort).toHaveBeenCalledTimes(1);
      expect(chatAbort).toHaveBeenCalledWith(leaving, "gateway-run-1");
      // Marked like a stop click, so the abort's own error chunk ends the turn
      // instead of being recorded as a provider failure (#978).
      expect(runs.get(leaving)?.abortedByUser).toBe(true);
      expect(runs.get(staying)?.abortedByUser).toBe(false);

      // The tab learns why, and nothing after that.
      await within(closed, 2000);
      expect(frames).toEqual([
        {
          type: "error",
          code: "policy_account_deactivated",
          message: "Your account has been deactivated.",
        },
      ]);

      // On the trail with the admin as the actor, like the deactivation.
      let rows: (typeof auditLog.$inferSelect)[] = [];
      for (let i = 0; i < 100 && rows.length === 0; i++) {
        rows = await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.eventType, "chat.run_aborted"),
              eq(auditLog.resource, "agent:agent-ops")
            )
          );
        if (rows.length === 0) await new Promise((r) => setTimeout(r, 20));
      }
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: "user", outcome: "success" });
      expect(rows[0].detail).toEqual({
        agent: { id: "agent-ops", name: "Ops Agent" },
        sessionKey: leaving,
        runId: "gateway-run-1",
        reason: "account_deactivated",
      });
      // #824: the acting admin is the pseudonymized actorId, never a raw id.
      expect(JSON.stringify(rows[0].detail)).not.toContain(admin.id);
    } finally {
      runs.delete(leaving);
      runs.delete(staying);
    }
  });

  it("keeps aborting, as the admin, a reply its first abort did not stop", async () => {
    // OpenClaw answers `aborted: false` for a run it has not registered yet —
    // or is just registering — and leaves no tombstone, so the run can start
    // after that answer. Deactivation keeps asking by the runId after the
    // response has gone out, and records the abort that took effect.
    const admin = await insertUser("Admin", "admin");
    const member = await insertUser("Leaving Member", "member");
    asAdmin(admin);
    await openChat(member.id);

    const runs = getActiveRunsSingleton();
    const leaving = directSessionKey("agent-late", member.id);
    runs.registerPending({
      runId: "provisional-3",
      sessionKey: leaving,
      agentId: "agent-late",
      userId: member.id,
      agentName: "Late Agent",
      submittedAt: Date.now(),
      currentMessageId: "msg-3",
      ws: {} as never,
    });
    runs.markFirstChunk(leaving, Date.now(), "gateway-run-3");
    const run = runs.get(leaving)!;
    const chatAbort = vi.fn().mockResolvedValue({ ok: true, aborted: false, runIds: [] });
    const request = vi.fn().mockResolvedValue({
      type: "res",
      id: "x",
      ok: true,
      payload: { ok: true, aborted: true, runIds: ["gateway-run-3"] },
    });
    const agentWait = vi.fn().mockResolvedValue({ status: "timeout" });
    setOpenClawClient({ ...fakeOpenClaw(), chatAbort, request, agentWait } as never);

    try {
      const res = await deactivate(member.id);
      expect(res.status).toBe(200);
      await run.abortFollowUp;

      // A bare `chat.abort` RPC — never `chatAbort`, which would also end
      // whatever local stream is open on the session by then.
      expect(chatAbort).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith("chat.abort", {
        sessionKey: leaving,
        runId: "gateway-run-3",
      });

      let rows: (typeof auditLog.$inferSelect)[] = [];
      for (let i = 0; i < 100 && rows.length < 2; i++) {
        rows = await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.eventType, "chat.run_aborted"),
              eq(auditLog.resource, "agent:agent-late")
            )
          );
        if (rows.length < 2) await new Promise((r) => setTimeout(r, 20));
      }
      const byOutcome = Object.fromEntries(rows.map((r) => [r.outcome, r]));
      expect(rows).toHaveLength(2);
      expect(byOutcome.failure.detail).toEqual({
        agent: { id: "agent-late", name: "Late Agent" },
        sessionKey: leaving,
        runId: "gateway-run-3",
        reason: "account_deactivated",
      });
      expect(byOutcome.success.detail).toEqual({
        agent: { id: "agent-late", name: "Late Agent" },
        sessionKey: leaving,
        runId: "gateway-run-3",
        reason: "account_deactivated",
        followUp: "aborted_by_run_id",
      });
      // Same actor as the deactivation's own row: the admin, pseudonymized.
      expect(byOutcome.success.actorId).toBe(byOutcome.failure.actorId);
      expect(JSON.stringify(byOutcome.success.detail)).not.toContain(admin.id);
    } finally {
      runs.delete(leaving);
    }
  });

  it("lets a reactivated user open a chat again", async () => {
    const admin = await insertUser("Admin", "admin");
    const member = await insertUser("Returning Member", "member");
    asAdmin(admin);
    await deactivate(member.id);

    const res = await REACTIVATE(
      new NextRequest(`http://localhost/api/users/${member.id}/reactivate`, { method: "POST" }),
      { params: Promise.resolve({ userId: member.id }) }
    );
    expect(res.status).toBe(200);

    const { tab, closed } = await openChat(member.id);
    expect(await within(closed, 300)).toBe("still open");
    expect(tab.readyState).toBe(WebSocket.OPEN);
    expect(getUserSocketRegistry().isRevoked(member.id)).toBe(false);
  });
});
