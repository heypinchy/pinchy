// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrajectoryReadMethod, readSessionTrajectory } from "./trajectory-reader";

// The two tables as OpenClaw 2026.9 creates them in
// `<stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite` (columns trimmed to
// the ones the reader touches; copied from a live 2026.9.2 database).
const SCHEMA = `
  CREATE TABLE session_nodes (
    session_key TEXT NOT NULL PRIMARY KEY,
    current_session_id TEXT NOT NULL,
    entry_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE trajectory_runtime_events (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    run_id TEXT,
    event_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  ) STRICT;
`;

let stateDir: string;

function seedAgentDb(agentId: string, seed: (db: DatabaseSync) => void): void {
  const dir = join(stateDir, "agents", agentId, "agent");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "openclaw-agent.sqlite"));
  db.exec(SCHEMA);
  seed(db);
  db.close();
}

function addSession(db: DatabaseSync, sessionKey: string, sessionId: string): void {
  db.prepare(
    "insert into session_nodes (session_key, current_session_id, entry_json, updated_at) values (?, ?, '{}', 0)"
  ).run(sessionKey, sessionId);
}

function addEvent(db: DatabaseSync, sessionId: string, seq: number, event: object): void {
  db.prepare(
    "insert into trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) values (?, ?, ?, ?, 0)"
  ).run(sessionId, seq, "run-1", JSON.stringify(event));
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pinchy-audit-trajectory-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("readSessionTrajectory", () => {
  it("resolves a session key and returns its trajectory events as JSONL, in seq order", () => {
    seedAgentDb("smithers", (db) => {
      addSession(db, "agent:smithers:direct:user1", "ses-1");
      // Inserted out of order: the reader, not insertion order, owns the order.
      addEvent(db, "ses-1", 2, { type: "model.completed" });
      addEvent(db, "ses-1", 1, { type: "prompt.submitted" });
      addEvent(db, "ses-other", 1, { type: "foreign" });
    });

    expect(
      readSessionTrajectory({
        stateDir,
        agentId: "smithers",
        sessionKey: "agent:smithers:direct:user1",
      })
    ).toEqual({
      sessionId: "ses-1",
      jsonl: '{"type":"prompt.submitted"}\n{"type":"model.completed"}\n',
    });
  });

  it("matches the session key case-insensitively, as OpenClaw lowercases the user segment", () => {
    seedAgentDb("smithers", (db) => {
      addSession(db, "agent:smithers:direct:1bcjabc", "ses-1");
      addEvent(db, "ses-1", 1, { type: "prompt.submitted" });
    });

    const result = readSessionTrajectory({
      stateDir,
      agentId: "smithers",
      sessionKey: "agent:smithers:direct:1BCjAbc",
    });
    expect(result.sessionId).toBe("ses-1");
  });

  it("reads a given sessionId directly, without a session key", () => {
    seedAgentDb("smithers", (db) => {
      addEvent(db, "ses-archived", 1, { type: "prompt.submitted" });
    });

    expect(
      readSessionTrajectory({ stateDir, agentId: "smithers", sessionId: "ses-archived" })
    ).toEqual({ sessionId: "ses-archived", jsonl: '{"type":"prompt.submitted"}\n' });
  });

  it("returns jsonl null for a known session that has no trajectory yet", () => {
    seedAgentDb("smithers", (db) => addSession(db, "agent:smithers:direct:u", "ses-1"));

    expect(
      readSessionTrajectory({
        stateDir,
        agentId: "smithers",
        sessionKey: "agent:smithers:direct:u",
      })
    ).toEqual({ sessionId: "ses-1", jsonl: null });
  });

  it("returns nulls for an unknown session key", () => {
    seedAgentDb("smithers", () => {});

    expect(
      readSessionTrajectory({
        stateDir,
        agentId: "smithers",
        sessionKey: "agent:smithers:direct:x",
      })
    ).toEqual({ sessionId: null, jsonl: null });
  });

  it("returns nulls for an agent that has no database yet, without creating one", () => {
    expect(
      readSessionTrajectory({ stateDir, agentId: "fresh", sessionKey: "agent:fresh:direct:u" })
    ).toEqual({ sessionId: null, jsonl: null });
  });

  it.each(["../etc", "a/b", "a\\b", "", "a\0b"])(
    "refuses the unsafe agentId %j instead of building a path from it",
    (agentId) => {
      expect(() => readSessionTrajectory({ stateDir, agentId, sessionKey: "k" })).toThrow(
        /agentId/
      );
    }
  );
});

describe("createTrajectoryReadMethod", () => {
  it("answers with the trajectory read under the runtime's state directory", () => {
    seedAgentDb("smithers", (db) => {
      addSession(db, "agent:smithers:direct:u", "ses-1");
      addEvent(db, "ses-1", 1, { type: "prompt.submitted" });
    });
    const respond = vi.fn();

    createTrajectoryReadMethod(() => stateDir)({
      params: { agentId: "smithers", sessionKey: "agent:smithers:direct:u" },
      respond,
    });

    expect(respond).toHaveBeenCalledWith(true, {
      sessionId: "ses-1",
      jsonl: '{"type":"prompt.submitted"}\n',
    });
  });

  it("rejects a request that names neither a session key nor a session id", () => {
    const respond = vi.fn();

    createTrajectoryReadMethod(() => stateDir)({ params: { agentId: "smithers" }, respond });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: expect.stringMatching(/sessionKey or sessionId/),
    });
  });

  it("rejects an unsafe agentId as an invalid request", () => {
    const respond = vi.fn();

    createTrajectoryReadMethod(() => stateDir)({
      params: { agentId: "../etc", sessionKey: "k" },
      respond,
    });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: expect.stringMatching(/agentId/),
    });
  });

  it("reports a database it cannot read as unavailable instead of throwing into the gateway", () => {
    const dir = join(stateDir, "agents", "broken", "agent");
    mkdirSync(join(dir, "openclaw-agent.sqlite"), { recursive: true }); // a directory, not a db
    const respond = vi.fn();

    createTrajectoryReadMethod(() => stateDir)({
      params: { agentId: "broken", sessionKey: "k" },
      respond,
    });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: expect.any(String),
    });
  });
});
