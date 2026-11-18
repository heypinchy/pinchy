// The trajectory readers ask OpenClaw for a session's trajectory over the
// gateway connection (`pinchy.trajectory.read`, served by the pinchy-audit
// plugin). OpenClaw 2026.9 keeps sessions in a per-agent SQLite database at
// mode 0600 that Pinchy's container cannot read, so the files these readers
// used to open are gone.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetClient } = vi.hoisted(() => ({ mockGetClient: vi.fn() }));

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

import {
  resolveSessionId,
  readTrajectoryJsonl,
  TrajectoryFileNotFoundError,
  TRAJECTORY_READ_METHOD,
} from "@/lib/diagnostics/jsonl-reader";

function ok(payload: Record<string, unknown>) {
  return { type: "res", id: "1", ok: true, payload };
}

function refused(message: string) {
  return { type: "res", id: "1", ok: false, error: { code: "UNAVAILABLE", message } };
}

let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  request = vi.fn();
  mockGetClient.mockReset();
  mockGetClient.mockReturnValue({ request });
});

describe("resolveSessionId", () => {
  it("asks the gateway method for the session key's current session", async () => {
    request.mockResolvedValue(ok({ sessionId: "ses_111", jsonl: null }));

    expect(await resolveSessionId("agt_abc", "agent:agt_abc:direct:user1")).toBe("ses_111");
    expect(request).toHaveBeenCalledWith(TRAJECTORY_READ_METHOD, {
      agentId: "agt_abc",
      sessionKey: "agent:agt_abc:direct:user1",
    });
    expect(TRAJECTORY_READ_METHOD).toBe("pinchy.trajectory.read");
  });

  it("returns null when the gateway knows no session for the key", async () => {
    request.mockResolvedValue(ok({ sessionId: null, jsonl: null }));

    expect(await resolveSessionId("agt_abc", "agent:agt_abc:direct:nope")).toBeNull();
  });

  it("returns null for an answer without a usable sessionId", async () => {
    request.mockResolvedValue(ok({ sessionId: "", jsonl: null }));

    expect(await resolveSessionId("agt_abc", "agent:agt_abc:direct:u")).toBeNull();
  });

  it("uses the client it is given instead of the global one", async () => {
    const own = { request: vi.fn().mockResolvedValue(ok({ sessionId: "ses_own", jsonl: null })) };

    expect(await resolveSessionId("agt_abc", "agent:agt_abc:direct:u", own)).toBe("ses_own");
    expect(own.request).toHaveBeenCalledTimes(1);
    expect(mockGetClient).not.toHaveBeenCalled();
  });

  it("throws the gateway's reason when it refuses, rather than reporting no session", async () => {
    // openclaw-node RESOLVES on an error response; treating that as "no
    // session" would turn a broken read into a silent zero-usage turn.
    request.mockResolvedValue(refused("database is locked"));

    await expect(resolveSessionId("agt_abc", "agent:agt_abc:direct:u")).rejects.toThrow(
      /database is locked/
    );
  });

  it("rejects an agentId with path traversal without asking the gateway", async () => {
    await expect(resolveSessionId("../etc", "k")).rejects.toThrow(/agentId/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("readTrajectoryJsonl", () => {
  it("returns the session's trajectory as JSONL", async () => {
    const jsonl = '{"type":"session.started"}\n{"type":"model.completed"}\n';
    request.mockResolvedValue(ok({ sessionId: "ses_111", jsonl }));

    expect(await readTrajectoryJsonl("agt_abc", "ses_111")).toBe(jsonl);
    expect(request).toHaveBeenCalledWith(TRAJECTORY_READ_METHOD, {
      agentId: "agt_abc",
      sessionId: "ses_111",
    });
  });

  it("throws TrajectoryFileNotFoundError when no trajectory is recorded", async () => {
    request.mockResolvedValue(ok({ sessionId: "ses_missing", jsonl: null }));

    const err = await readTrajectoryJsonl("agt_abc", "ses_missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrajectoryFileNotFoundError);
    expect((err as TrajectoryFileNotFoundError).message).toMatch(/ses_missing/);
  });

  it("throws the gateway's reason when it refuses, not TrajectoryFileNotFoundError", async () => {
    request.mockResolvedValue(refused("pinchy.trajectory.read: unknown method"));

    const err = await readTrajectoryJsonl("agt_abc", "ses_111").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TrajectoryFileNotFoundError);
    expect((err as Error).message).toMatch(/unknown method/);
  });

  it("propagates a missing gateway connection instead of hiding it", async () => {
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });

    await expect(readTrajectoryJsonl("agt_abc", "ses_111")).rejects.toThrow(/not initialized/);
  });

  it.each([
    ["agentId", "../etc", "ses_111"],
    ["agentId", "a/b", "ses_111"],
    ["sessionId", "agt_abc", "../../secrets"],
    ["sessionId", "agt_abc", "a\\b"],
    ["sessionId", "agt_abc", "a\0b"],
  ])("rejects an unsafe %s without asking the gateway", async (kind, agentId, sessionId) => {
    await expect(readTrajectoryJsonl(agentId, sessionId)).rejects.toThrow(new RegExp(kind));
    expect(request).not.toHaveBeenCalled();
  });
});
