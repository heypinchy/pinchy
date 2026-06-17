import { describe, it, expect, vi, beforeEach } from "vitest";

// OpenClaw (root) rewrites `sessions.json` / `*.trajectory.jsonl` as mode 0600
// on every session update; start-openclaw.sh's chmod loop reopens them to
// 0644/0755 within ~50ms, but Pinchy (uid 999) can read in that window and hit
// a TRANSIENT EACCES. The per-turn usage recorder reads these files on the
// low-latency chat-`done` path and the poller backstop — if a transient EACCES
// silently aborts the read, the turn's usage is dropped until a later poll,
// which under-records usage in production and (in CI) leaks a prior turn's row
// into a later test's usage-tracking measurement window.
//
// We can't reproduce a privileged chmod race against real files in a unit test,
// so we mock `readFile` to drive the transient-EACCES sequence deterministically
// and assert the retry contract (mirrors the established #314 retry pattern in
// openclaw-config/write.ts: a bounded budget that covers two chmod-loop ticks).
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual, readFile: readFileMock }, readFile: readFileMock };
});

import {
  resolveSessionId,
  readTrajectoryJsonl,
  TrajectoryFileNotFoundError,
} from "@/lib/diagnostics/jsonl-reader";

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

const AGENT = "agt_retry";
const KEY = "agent:agt_retry:direct:user1";
const SESSION = "ses_111";

beforeEach(() => {
  readFileMock.mockReset();
});

describe("jsonl-reader EACCES resilience (sessions-file chmod race)", () => {
  it("resolveSessionId retries a transient EACCES and resolves once the file is readable", async () => {
    readFileMock
      .mockRejectedValueOnce(errno("EACCES"))
      .mockRejectedValueOnce(errno("EACCES"))
      .mockResolvedValueOnce(JSON.stringify({ [KEY]: { sessionId: SESSION } }));

    await expect(resolveSessionId(AGENT, KEY)).resolves.toBe(SESSION);
    expect(readFileMock).toHaveBeenCalledTimes(3);
  });

  it("resolveSessionId propagates a persistent EACCES after exhausting the bounded budget", async () => {
    readFileMock.mockRejectedValue(errno("EACCES"));

    await expect(resolveSessionId(AGENT, KEY)).rejects.toThrow(/EACCES/);
    // Retried (more than one attempt) but bounded — never an unbounded spin.
    expect(readFileMock.mock.calls.length).toBeGreaterThan(1);
    expect(readFileMock.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("resolveSessionId does NOT retry ENOENT — a genuinely missing index returns null on the first miss", async () => {
    readFileMock.mockRejectedValueOnce(errno("ENOENT"));

    await expect(resolveSessionId(AGENT, KEY)).resolves.toBeNull();
    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it("readTrajectoryJsonl retries a transient EACCES and resolves once the file is readable", async () => {
    readFileMock
      .mockRejectedValueOnce(errno("EACCES"))
      .mockResolvedValueOnce('{"type":"model.completed"}\n');

    await expect(readTrajectoryJsonl(AGENT, SESSION)).resolves.toBe('{"type":"model.completed"}\n');
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });

  it("readTrajectoryJsonl does NOT retry ENOENT — a genuinely missing trajectory throws the typed error on the first miss", async () => {
    readFileMock.mockRejectedValueOnce(errno("ENOENT"));

    await expect(readTrajectoryJsonl(AGENT, SESSION)).rejects.toBeInstanceOf(
      TrajectoryFileNotFoundError
    );
    expect(readFileMock).toHaveBeenCalledTimes(1);
  });
});
