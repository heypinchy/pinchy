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
        contextTokens: null,
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

// Context size is NOT `data.usage.input`. A single turn drives a whole tool
// loop — roughly 11 LLM calls for the production turns below — and
// `data.usage` SUMS every one of them. The context that actually hit the
// model's window is the size of the LAST call, in
// `data.promptCache.lastCallUsage`. Confirmed on production 2026-07-15
// (agent "Piper", deepseek-v4-pro):
//
//   ts        data.usage.input   lastCallUsage.input
//   12:51:21         1,856,700               169,592
//   12:55:22         2,212,441               171,097
//   13:01:15         2,038,006               170,306
//
// Reading `data.usage.input` as the context would over-report by ~11x and
// make every utilization figure meaningless. The two are kept separate on
// purpose: `inputTokens` is what gets BILLED (every call counts),
// `contextTokens` is what gets sent (only the last call).
describe("extractPerTurnUsage context size", () => {
  it("reads the context size from promptCache.lastCallUsage, not the summed data.usage", () => {
    const [row] = extractPerTurnUsage([
      modelCompleted({
        provider: "ollama-cloud",
        modelId: "deepseek-v4-pro",
        data: {
          usage: { input: 1856700, output: 4047, total: 1860747 },
          promptCache: {
            lastCallUsage: { input: 169592, output: 2073, cacheRead: 0, cacheWrite: 0 },
          },
        },
      }),
    ]);

    expect(row.inputTokens).toBe(1856700);
    expect(row.contextTokens).toBe(169592);
  });

  it("counts cached prompt tokens toward the context size", () => {
    // On a caching provider the cached prefix is still part of the prompt the
    // model sees — it's only billed differently. Excluding it would under-report
    // utilization on exactly the providers that run the longest contexts.
    const [row] = extractPerTurnUsage([
      modelCompleted({
        data: {
          usage: { input: 5, output: 630, cacheRead: 32336, cacheWrite: 16956, total: 49927 },
          promptCache: {
            lastCallUsage: { input: 4000, output: 630, cacheRead: 96000, cacheWrite: 0 },
          },
        },
      }),
    ]);

    expect(row.contextTokens).toBe(100000);
  });

  it("counts freshly cached prompt tokens toward the context size", () => {
    // cacheWrite is the same argument as cacheRead, one call earlier: tokens
    // being written to the cache are prompt tokens the model reads on THIS
    // call — they are just billed at the write rate. The four classes are
    // disjoint, which `data.usage` proves arithmetically: the fixture's
    // 5 + 630 + 32336 + 16956 is exactly its `total` of 49927. So the prompt
    // is input + cacheRead + cacheWrite.
    //
    // Omitting cacheWrite under-reports precisely where the column earns its
    // keep: on the turn where the context GROWS, the new tail is cacheWrite.
    // A cold turn (nothing cached yet) would report ~0 context — the same
    // "reads as 0% utilization" failure the null-vs-0 rule exists to prevent.
    const [row] = extractPerTurnUsage([
      modelCompleted({
        data: {
          usage: { input: 5, output: 630, cacheRead: 0, cacheWrite: 150000, total: 150635 },
          promptCache: {
            lastCallUsage: { input: 4000, output: 630, cacheRead: 0, cacheWrite: 96000 },
          },
        },
      }),
    ]);

    expect(row.contextTokens).toBe(100000);
  });

  it("reports a null context size when the event carries no promptCache", () => {
    // Null, not 0 — "we don't know" must never render as "the context is empty",
    // which would silently read as 0% utilization.
    const [row] = extractPerTurnUsage([
      modelCompleted({ data: { usage: { input: 100, output: 20, total: 120 } } }),
    ]);

    expect(row.contextTokens).toBeNull();
  });

  it("reports null, not 0, when lastCallUsage carries no prompt token classes", () => {
    // Hanging the "unknown" signal on the mere PRESENCE of the block leaks a 0
    // through whenever the shape is empty or unrecognized — and 0 is a lie the
    // dashboard cannot detect, because "context was empty" is a legal reading.
    // No prompt classes we understand ⇒ we do not know the context size.
    const [row] = extractPerTurnUsage([
      modelCompleted({
        data: {
          usage: { input: 100, output: 20, total: 120 },
          promptCache: { lastCallUsage: { output: 20 } },
        },
      }),
    ]);

    expect(row.contextTokens).toBeNull();
  });
});
