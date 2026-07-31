// @vitest-environment node
//
// Deterministic coverage for the TOOL_THEN_RATE_LIMIT trigger's round
// selection (#1013).
//
// `19-durable-agent-error-banner.spec.ts:72` asserts that a failure AFTER a
// tool call gates Retry behind a duplicate-write confirm. That confirm only
// appears when `sideEffects` is true, and `sideEffects` is true only when the
// run actually executed a tool — so the whole spec rests on this trigger
// dispatching `pinchy_ls` in round 1 and the 429 only in round 2.
//
// When that spec failed in CI, the run artifacts could not say which half broke:
// OpenClaw does not log tool executions at the E2E log level, postgres has no
// statement logging, and pinchy has no request logging. Round selection is a
// pure function of the request's messages, though, so it does not need any of
// that — this file pins it in-process, against the REAL dispatcher.
//
// The histories below are the ones the integration suite actually produces: its
// specs share one Smithers session, so by the time this trigger runs the
// conversation already contains earlier triggers — including
// `E2E_RATE_LIMIT_ERROR`, whose handler sits directly above this one and would
// swallow the request if selection ever keyed off the wrong message.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  handleRequest,
  FAKE_OLLAMA_TOOL_THEN_RATE_LIMIT_TRIGGER,
  FAKE_OLLAMA_TOOL_THEN_RATE_LIMIT_TOOL,
  FAKE_OLLAMA_RATE_LIMIT_TRIGGER,
} from "../../../e2e/shared/fake-ollama/fake-ollama-server";

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  server = http.createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

// Pinchy emits ollama as `api: "openai-completions"`, so OpenClaw's pi-ai
// dispatches to /v1/chat/completions — the surface this spec's traffic uses.
async function postChat(messages: unknown[]): Promise<{ status: number; body: string }> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream: true, messages }),
  });
  return { status: res.status, body: await res.text() };
}

const triggerMessage = {
  role: "user",
  content: `${FAKE_OLLAMA_TOOL_THEN_RATE_LIMIT_TRIGGER}: do the thing`,
};

// What the shared Smithers session looks like by the time this spec runs: the
// preceding specs in the same file and its neighbours have already exchanged
// several turns, and the turn immediately before is the bare-429 trigger.
const SHARED_SESSION_HISTORY = [
  { role: "user", content: "E2E_SLOW_STREAM: list one..ten" },
  { role: "assistant", content: "one two three four five six seven eight nine ten" },
  { role: "user", content: "E2E_ABORT_STREAM: please respond slowly" },
  { role: "assistant", content: "lima" },
  { role: "user", content: `${FAKE_OLLAMA_RATE_LIMIT_TRIGGER}: please do the thing` },
];

describe("fake-ollama TOOL_THEN_RATE_LIMIT round selection (#1013)", () => {
  it("dispatches the tool in round 1 of a fresh session", async () => {
    const { status, body } = await postChat([triggerMessage]);

    expect(status).toBe(200);
    expect(body).toContain(FAKE_OLLAMA_TOOL_THEN_RATE_LIMIT_TOOL);
    // The 429 belongs to round 2 only — a rate limit here would mean the run
    // fails without ever performing the side effect the spec is about.
    expect(body).not.toContain("rate_limit_exceeded");
  });

  it("still dispatches the tool when the shared session already carries earlier triggers", async () => {
    // The regression this guards: selection keying off any message in the
    // history rather than the LAST user message would match the preceding
    // `E2E_RATE_LIMIT_ERROR` turn, return a bare 429, and produce exactly the
    // observed failure — an error with no tool call, so no duplicate-write
    // warning and an ungated Retry.
    const { status, body } = await postChat([...SHARED_SESSION_HISTORY, triggerMessage]);

    expect(status).toBe(200);
    expect(body).toContain(FAKE_OLLAMA_TOOL_THEN_RATE_LIMIT_TOOL);
    expect(body).not.toContain("rate_limit_exceeded");
  });

  it("returns the 429 in round 2, once the tool result comes back", async () => {
    const { status } = await postChat([
      ...SHARED_SESSION_HISTORY,
      triggerMessage,
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: FAKE_OLLAMA_TOOL_THEN_RATE_LIMIT_TOOL, arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "briefing.docx\nnotes.md" },
    ]);

    expect(status).toBe(429);
  });

  it("does not let a stale tool result from an earlier turn skip round 1", async () => {
    // `lastRoundHasToolResult` only inspects messages after the last user
    // message, so an earlier turn's tool result must not be read as "this run
    // already called its tool". If it were, the trigger would 429 immediately
    // and the spec would see a failure with no side effect — indistinguishable
    // from the bug it is trying to catch.
    const { status, body } = await postChat([
      ...SHARED_SESSION_HISTORY,
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "old", type: "function", function: { name: "knowledge_search", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "old", content: "an earlier turn's result" },
      triggerMessage,
    ]);

    expect(status).toBe(200);
    expect(body).toContain(FAKE_OLLAMA_TOOL_THEN_RATE_LIMIT_TOOL);
  });
});
