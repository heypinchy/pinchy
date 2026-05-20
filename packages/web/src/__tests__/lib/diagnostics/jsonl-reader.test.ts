import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionId, readTrajectoryJsonl } from "@/lib/diagnostics/jsonl-reader";

let stateDir: string;
let prevEnv: string | undefined;

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "diag-jsonl-reader-"));
  prevEnv = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = prevEnv;
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Wipe and recreate state dir between tests
  await rm(stateDir, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true });
});

async function writeIndex(agentId: string, body: unknown) {
  const dir = join(stateDir, "agents", agentId, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sessions.json"), JSON.stringify(body), "utf8");
}

describe("resolveSessionId", () => {
  it("returns the sessionId for a matching sessionKey", async () => {
    const agentId = "agt_abc";
    const sessionKey = "agent:agt_abc:direct:user1";
    await writeIndex(agentId, {
      [sessionKey]: {
        sessionId: "ses_111",
        sessionFile: "/root/.openclaw/agents/agt_abc/sessions/ses_111.jsonl",
        updatedAt: "2026-05-19T12:00:00.000Z",
        status: "idle",
      },
    });
    expect(await resolveSessionId(agentId, sessionKey)).toBe("ses_111");
  });

  it("returns null when sessionKey is not present in the index", async () => {
    const agentId = "agt_abc";
    await writeIndex(agentId, {
      "agent:agt_abc:direct:someone-else": { sessionId: "ses_222" },
    });
    expect(await resolveSessionId(agentId, "agent:agt_abc:direct:nope")).toBeNull();
  });

  it("returns null when the index file does not exist", async () => {
    expect(await resolveSessionId("agt_missing", "agent:agt_missing:direct:u")).toBeNull();
  });

  it("returns null when index has no sessionId field on the matched entry", async () => {
    const agentId = "agt_abc";
    const sessionKey = "agent:agt_abc:direct:user1";
    await writeIndex(agentId, { [sessionKey]: { updatedAt: "2026-01-01" } });
    expect(await resolveSessionId(agentId, sessionKey)).toBeNull();
  });
});

describe("readTrajectoryJsonl", () => {
  it("reads the file at <stateDir>/agents/<agentId>/sessions/<sessionId>.trajectory.jsonl", async () => {
    const agentId = "agt_abc";
    const sessionId = "ses_111";
    const dir = join(stateDir, "agents", agentId, "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.trajectory.jsonl`), '{"type":"x"}\n', "utf8");
    expect(await readTrajectoryJsonl(agentId, sessionId)).toBe('{"type":"x"}\n');
  });

  it("throws a typed error when the trajectory file is missing", async () => {
    await expect(readTrajectoryJsonl("agt_missing", "ses_none")).rejects.toThrow();
  });
});
