import { describe, it, expect } from "vitest";
import { extractPerTurnUsage } from "@/lib/usage-from-trajectory";

// Shapes verified empirically against the live staging OpenClaw 2026.6.5
// trajectory: each `model.completed` event carries the EXACT per-turn token
// usage in `data.usage` — `{input, output, total}` for non-caching providers
// (ollama-cloud) and `{input, output, cacheRead, cacheWrite, total}` for
// caching providers (anthropic). Cache fields are absent (→ 0) when the
// provider doesn't cache. One event = one turn, uniquely keyed by `runId`.
function modelCompleted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "model.completed",
    seq: 5,
    sessionId: "sess-1",
    sessionKey: "agent:a1:direct:u1",
    runId: "run-1",
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    data: { usage: { input: 5, output: 630, cacheRead: 32336, cacheWrite: 16956, total: 49927 } },
    ...over,
  };
}

describe("extractPerTurnUsage", () => {
  it("extracts exact per-turn token classes from data.usage (anthropic, with cache)", () => {
    expect(extractPerTurnUsage([modelCompleted()])).toEqual([
      {
        runId: "run-1",
        seq: 5,
        sessionId: "sess-1",
        sessionKey: "agent:a1:direct:u1",
        model: "anthropic/claude-sonnet-4-6",
        inputTokens: 5,
        outputTokens: 630,
        cacheReadTokens: 32336,
        cacheWriteTokens: 16956,
      },
    ]);
  });

  it("defaults cache classes to 0 for non-caching providers (ollama-cloud)", () => {
    const [row] = extractPerTurnUsage([
      modelCompleted({
        seq: 7,
        runId: "run-2",
        provider: "ollama-cloud",
        modelId: "deepseek-v4-flash",
        data: { usage: { input: 86377, output: 508, total: 86885 } },
      }),
    ]);
    expect(row).toMatchObject({
      runId: "run-2",
      model: "ollama-cloud/deepseek-v4-flash",
      inputTokens: 86377,
      outputTokens: 508,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("ignores non-model.completed events", () => {
    const events = [
      { type: "session.started", seq: 1 },
      { type: "prompt.submitted", seq: 2 },
      modelCompleted({ seq: 3, runId: "run-3" }),
      { type: "session.ended", seq: 99 },
    ];
    expect(extractPerTurnUsage(events).map((r) => r.runId)).toEqual(["run-3"]);
  });

  it("skips a model.completed without a runId (cannot dedup it) or without usage", () => {
    const events = [
      modelCompleted({ runId: undefined }),
      modelCompleted({ runId: "run-x", data: {} }),
      modelCompleted({ runId: "run-ok" }),
    ];
    expect(extractPerTurnUsage(events).map((r) => r.runId)).toEqual(["run-ok"]);
  });

  it("captures subagent turns (their own runId) — they are real token spend", () => {
    const sub = modelCompleted({
      runId: "announce:v1:agent:a1:subagent:s1:r9",
      provider: "ollama-cloud",
      modelId: "deepseek-v4-flash",
      data: { usage: { input: 100, output: 10, total: 110 } },
    });
    const rows = extractPerTurnUsage([modelCompleted({ runId: "run-main" }), sub]);
    expect(rows.map((r) => r.runId)).toEqual(["run-main", "announce:v1:agent:a1:subagent:s1:r9"]);
  });

  it("returns [] for empty input", () => {
    expect(extractPerTurnUsage([])).toEqual([]);
  });
});
