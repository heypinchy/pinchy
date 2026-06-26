// packages/web/e2e/integration/zz-tool-allowlist.spec.ts
//
// Runtime read-side guard for the fail-closed tool allowlist (#605).
//
// Pinchy emits `agents.list[].tools.allow` (no profile) so OpenClaw resolves an
// absolute allowlist: only Pinchy plugin tools + a few read-only built-ins
// (memory/pdf/image/session_status) reach the model; every other built-in is
// denied — cron, gateway, message, nodes, subagents, sessions_*, raw exec/fs/
// web, the native browser. The unit emitter test proves Pinchy WRITES that
// shape; this spec proves OpenClaw HONORS it at runtime by inspecting the tool
// list OpenClaw actually advertises to the model (captured by the fake Ollama).
//
// Without this, a future OpenClaw change to allow-resolution semantics could
// silently re-expose forbidden built-ins and only this real round-trip would
// catch it. See also tool-registry.test.ts (emit-layer drift guard).
//
// `zz-` prefix on purpose: this spec posts a message into Smithers' shared
// conversation, and `agent-chat.spec.ts` asserts a *pristine* single response
// with a non-`.last()` locator. The integration suite runs serially
// (workers:1), so running last keeps that assumption intact — every spec that
// tolerates accumulated history already uses `.last()`/`.first()`.
import { test, expect } from "@playwright/test";
import { FAKE_OLLAMA_PORT } from "../shared/fake-ollama/fake-ollama-server";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";

const TOOLS_SEEN_URL = `http://localhost:${FAKE_OLLAMA_PORT}/__pinchy_fake_ollama/tools-seen`;

// Built-ins a governed Pinchy agent must NEVER be offered. If any of these ever
// shows up in OpenClaw's advertised tool list, the allowlist has regressed.
const FORBIDDEN_BUILTINS = [
  "exec",
  "process",
  "code_execution",
  "read",
  "write",
  "edit",
  "apply_patch",
  "web_fetch",
  "web_search",
  "browser",
  "canvas",
  "cron",
  "gateway",
  "message",
  "nodes",
  "subagents",
  "sessions_spawn",
  "image_generate",
];

test.describe("Tool allowlist — fail-closed at runtime (#605)", () => {
  test("OpenClaw advertises only allowlisted tools to the model", async ({ page, request }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    // Drive one full model round-trip so OpenClaw advertises this agent's tools.
    // We don't assert on the reply text (other specs own the happy path) — the
    // tools-seen poll below is the synchronization point.
    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill("Hello, are you there?");
    await input.press("Enter");

    // The fake Ollama records the union of every tool OpenClaw advertised.
    // Poll until populated (the advertise lands when OpenClaw calls the model).
    let toolsSeen: string[] = [];
    await expect
      .poll(
        async () => {
          const res = await request.get(TOOLS_SEEN_URL);
          if (!res.ok()) return 0;
          toolsSeen = (await res.json()).tools as string[];
          return toolsSeen.length;
        },
        { timeout: 30000, message: "OpenClaw never advertised any tools to the model" }
      )
      .toBeGreaterThan(0);

    // (1) Fail-closed: not one forbidden built-in may be advertised.
    for (const forbidden of FORBIDDEN_BUILTINS) {
      expect(toolsSeen, `forbidden built-in "${forbidden}" must not be advertised`).not.toContain(
        forbidden
      );
    }

    // (2) Allowlist still lets governed tools through (not accidentally empty):
    //     memory_search is an intended read-only built-in present for every agent.
    expect(toolsSeen).toContain("memory_search");

    // (3) At least one Pinchy plugin tool reaches the model — proves plugin
    //     tools survive the allowlist, not just the built-in helpers.
    expect(
      toolsSeen.some((t) => t.startsWith("pinchy_") || t.startsWith("docs_")),
      `expected a Pinchy plugin tool among advertised tools: ${toolsSeen.join(", ")}`
    ).toBe(true);
  });
});
