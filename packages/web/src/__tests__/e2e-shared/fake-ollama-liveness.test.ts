// @vitest-environment node
//
// Unit coverage for the fake-ollama server's chat-liveness triggers (Task 1.2).
//
// The chat-liveness E2E specs (added in a later task) drive real traffic through
// OpenClaw to exercise two UI states:
//   - SLOW   → "taking longer than expected" (a response that stalls before it
//              starts streaming, then completes normally)
//   - DYING  → an authoritative terminal failure (a provider/stream that opens,
//              emits a partial token, then dies mid-response)
//
// This in-process test pins the trigger SELECTION and the WIRE SHAPE of both
// behaviours on BOTH surfaces the fake serves — the Ollama-native /api/chat
// (NDJSON) and the OpenAI-compatible /v1/chat/completions (SSE) path OC actually
// uses — so a regression surfaces fast, before the slow Dockerized E2E run.
//
// We exercise the real handleRequest (not an extracted helper) because the
// branching lives inline in the dispatcher exactly like the existing slow-stream
// trigger; testing the dispatcher is what guards against drift.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { DELAY_HINT_MS } from "@/lib/chat-liveness";
import {
  handleRequest,
  FAKE_OLLAMA_LIVENESS_SLOW_TRIGGER,
  FAKE_OLLAMA_LIVENESS_SLOW_RESPONSE,
  FAKE_OLLAMA_LIVENESS_SLOW_DELAY_MS,
  FAKE_OLLAMA_LIVENESS_DYING_TRIGGER,
  FAKE_OLLAMA_LIVENESS_DYING_PARTIAL,
} from "../../../e2e/shared/fake-ollama/fake-ollama-server";

/**
 * The stall this file drives the dispatcher with, via the server's env
 * override.
 *
 * The real trigger stalls FAKE_OLLAMA_LIVENESS_SLOW_DELAY_MS (18 s) so the E2E
 * banner spec has something to engage on. Sitting through that here bought
 * nothing — these cases assert trigger selection and wire shape, and both are
 * identical at any stall — while costing 49 s, a third of the file time of
 * `pnpm test` and therefore of every merge's required `quality` check.
 *
 * The 18 s value is NOT untested as a result: "the real stall out-waits the
 * client's delay hint" is the property that actually matters, and it is now
 * asserted directly (and instantly) at the bottom of this file, where before it
 * was only implied by a slow test that would have kept passing if someone
 * raised DELAY_HINT_MS past 18 s.
 *
 * 750 ms keeps the ordering assertion meaningful: with a 250 ms tolerance for
 * timer overshoot on a loaded CI host, a first byte before 500 ms still means
 * the stall did not precede the token.
 */
const TEST_STALL_MS = 750;
const STALL_TOLERANCE_MS = 250;

/**
 * Stream the words back-to-back too. After the stall, the fake emits the
 * response word-by-word at a real 500 ms — ~7 s for this 14-word response, on
 * top of the stall, per test. The rate changes nothing about the bytes these
 * cases assert, and the E2E specs (which DO need it slow) never set this.
 */
const TEST_STREAM_DELAY_MS = 0;

let server: http.Server;
let baseUrl: string;
let previousOverride: string | undefined;
let previousStreamOverride: string | undefined;

beforeEach(async () => {
  previousOverride = process.env.FAKE_OLLAMA_LIVENESS_SLOW_DELAY_MS;
  previousStreamOverride = process.env.FAKE_OLLAMA_SLOW_STREAM_DELAY_MS_OVERRIDE;
  process.env.FAKE_OLLAMA_LIVENESS_SLOW_DELAY_MS = String(TEST_STALL_MS);
  process.env.FAKE_OLLAMA_SLOW_STREAM_DELAY_MS_OVERRIDE = String(TEST_STREAM_DELAY_MS);
  server = http.createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (previousOverride === undefined) delete process.env.FAKE_OLLAMA_LIVENESS_SLOW_DELAY_MS;
  else process.env.FAKE_OLLAMA_LIVENESS_SLOW_DELAY_MS = previousOverride;
  if (previousStreamOverride === undefined)
    delete process.env.FAKE_OLLAMA_SLOW_STREAM_DELAY_MS_OVERRIDE;
  else process.env.FAKE_OLLAMA_SLOW_STREAM_DELAY_MS_OVERRIDE = previousStreamOverride;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

// Reads the whole body, plus the wall-clock time until the FIRST byte arrived.
// We can't rely on fetch streaming reliably for an aborted connection in every
// Node version, so we read raw text and also capture time-to-first-byte for the
// slow-start assertion.
async function readResponse(
  path: string,
  content: string
): Promise<{ ok: boolean; status: number; body: string; firstByteMs: number; errored: boolean }> {
  const started = Date.now();
  let firstByteMs = -1;
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content }] }),
    });
    const reader = res.body?.getReader();
    let body = "";
    const decoder = new TextDecoder();
    if (reader) {
      // Read until the stream ends OR the connection dies (dying trigger).
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (firstByteMs < 0) firstByteMs = Date.now() - started;
          body += decoder.decode(value, { stream: true });
        }
      } catch {
        // Premature close (socket destroyed) — expected for the dying trigger.
        return { ok: res.ok, status: res.status, body, firstByteMs, errored: true };
      }
    }
    return { ok: res.ok, status: res.status, body, firstByteMs, errored: false };
  } catch {
    return { ok: false, status: 0, body: "", firstByteMs, errored: true };
  }
}

describe("fake-ollama liveness SLOW trigger", () => {
  it(
    "stalls before the first token then completes a normal stream — Ollama-native /api/chat",
    async () => {
      const { ok, body, firstByteMs } = await readResponse(
        "/api/chat",
        `Please help ${FAKE_OLLAMA_LIVENESS_SLOW_TRIGGER} now`
      );
      expect(ok).toBe(true);
      // First byte must arrive only AFTER the configured stall — that ordering
      // is what makes a "taking longer" UI state engage before any text renders.
      expect(firstByteMs).toBeGreaterThanOrEqual(TEST_STALL_MS - STALL_TOLERANCE_MS);
      // The stream completes normally with the configured response text.
      const final = body
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { done?: boolean; done_reason?: string })
        .find((c) => c.done === true);
      expect(final, "slow stream must finish with a done:true chunk").toBeDefined();
      expect(final!.done_reason).toBe("stop");
      const text = body
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { message?: { content?: string } })
        .map((c) => c.message?.content ?? "")
        .join("");
      expect(text).toBe(FAKE_OLLAMA_LIVENESS_SLOW_RESPONSE);
    },
    TEST_STALL_MS + 10_000
  );

  it(
    "stalls before the first token then completes a normal SSE stream — OpenAI /v1/chat/completions",
    async () => {
      const { ok, body, firstByteMs } = await readResponse(
        "/v1/chat/completions",
        `Please help ${FAKE_OLLAMA_LIVENESS_SLOW_TRIGGER} now`
      );
      expect(ok).toBe(true);
      expect(firstByteMs).toBeGreaterThanOrEqual(TEST_STALL_MS - STALL_TOLERANCE_MS);
      // Completes cleanly: SSE [DONE] terminator and a stop finish_reason.
      expect(body).toContain("[DONE]");
      const text = body
        .split("\n\n")
        .map((line) => line.replace(/^data: /, "").trim())
        .filter((p) => p && p !== "[DONE]")
        .map((p) => JSON.parse(p) as { choices?: Array<{ delta?: { content?: string } }> })
        .map((c) => c.choices?.[0]?.delta?.content ?? "")
        .join("");
      expect(text).toBe(FAKE_OLLAMA_LIVENESS_SLOW_RESPONSE);
    },
    TEST_STALL_MS + 10_000
  );

  // The property the 18 s constant exists for, asserted directly instead of
  // being implied by a test that sat through it. A stall at or under the
  // client's delay hint means the E2E banner spec silently stops exercising the
  // banner: the run completes before the hint ever fires, the spec's other
  // assertions still pass, and the regression it guards ships unnoticed.
  it("stalls past the client's delay hint, so the 'taking longer' banner engages", () => {
    expect(FAKE_OLLAMA_LIVENESS_SLOW_DELAY_MS).toBeGreaterThan(DELAY_HINT_MS);
  });
});

describe("fake-ollama liveness DYING trigger", () => {
  it("opens the stream, emits a partial token, then dies — Ollama-native /api/chat", async () => {
    const { body, errored } = await readResponse(
      "/api/chat",
      `Please help ${FAKE_OLLAMA_LIVENESS_DYING_TRIGGER} now`
    );
    // The connection is torn down mid-stream — the reader sees a premature close.
    expect(errored).toBe(true);
    // What did arrive is the partial chunk, and it never reached done:true.
    expect(body).toContain(FAKE_OLLAMA_LIVENESS_DYING_PARTIAL);
    expect(body).not.toContain('"done":true');
  });

  it("opens the SSE stream, emits a partial token, then dies — OpenAI /v1/chat/completions", async () => {
    const { body, errored } = await readResponse(
      "/v1/chat/completions",
      `Please help ${FAKE_OLLAMA_LIVENESS_DYING_TRIGGER} now`
    );
    expect(errored).toBe(true);
    // A partial token arrived but the stream never completed: no terminal
    // finish_reason and no [DONE] terminator. (Each delta chunk carries
    // finish_reason:null by shape, so we assert the absence of the "stop"
    // terminal value and of the SSE terminator, not the substring entirely.)
    expect(body).toContain(FAKE_OLLAMA_LIVENESS_DYING_PARTIAL);
    expect(body).not.toContain("[DONE]");
    expect(body).not.toContain('"finish_reason":"stop"');
    expect(body).not.toContain("usage");
  });
});
