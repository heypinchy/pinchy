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

import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { mockSession } from "@/test-helpers/auth";
import { DELETE } from "@/app/api/users/[userId]/route";
import { POST as REACTIVATE } from "@/app/api/users/[userId]/reactivate/route";
import { ClientRouter } from "@/server/client-router";
import { SessionCache } from "@/server/session-cache";
import { getUserSocketRegistry, ACCOUNT_DEACTIVATED_CLOSE_CODE } from "@/server/user-sockets";

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
  return { tab, closed };
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
      { type: "error", message: "Your account has been deactivated." },
    ]);
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
