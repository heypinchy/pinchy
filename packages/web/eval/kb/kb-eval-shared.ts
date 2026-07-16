// packages/web/eval/kb/kb-eval-shared.ts
//
// Setup/teardown shared by the KB Eval Harness Layer-2 attribution self-test
// (packages/web/e2e/integration/kb-attribution.spec.ts, Task 2.3). Mirrors
// the "Plugin behavior — pinchy-knowledge" dispatch-coverage probe in
// e2e/integration/agent-chat.spec.ts almost exactly (fresh SHARED custom
// agent, grant `knowledge_search` only, wait for OC stable + dispatchable),
// split out here so the self-test's five per-trigger tests can share ONE
// agent instead of paying setup cost per trigger.
//
// Deliberately grants NO `pinchy-files` `allowed_paths`: the attribution
// self-test grades the SCRIPTED fake-ollama answer against a per-trigger
// `retrieved` fixture (see kb-attribution.spec.ts), not a real corpus
// search. With `allowedPaths = []`, Pinchy's knowledge-search route's
// `retrieve()` short-circuits to `[]` without ever calling an embedder — the
// same clean empty-success path the pinchy-knowledge dispatch probe relies
// on — so this suite needs no /api/embed support from fake-ollama.
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { login } from "../../e2e/integration/helpers";
import { waitForOpenClawStable, waitForAgentDispatchable } from "../../e2e/shared/dispatch-probe";

export const KB_EVAL_ALLOWED_TOOLS = ["knowledge_search"];

/**
 * Creates a shared custom agent, grants it `knowledge_search` only, and waits
 * for OpenClaw to both stabilize (connected, no config pushes in flight) and
 * report the new agent as dispatchable. `page` must already be authenticated
 * (call `login(page)` first, or let this call it — see below); the caller
 * owns the browser context and is responsible for closing it.
 *
 * Name must stay <=30 chars (agent-name schema cap), mirroring the
 * `KB-Dispatch-${Date.now()}` pattern in agent-chat.spec.ts's
 * pinchy-knowledge probe (a bare `KnowledgeAttribution-${Date.now()}` would
 * exceed the cap and 400).
 */
export async function setupKbAgent(page: Page): Promise<{ agentId: string }> {
  await login(page);

  const createRes = await page.request.post("/api/agents", {
    data: { name: `KB-Attrib-${Date.now()}`, templateId: "custom" },
  });
  expect(createRes.status(), await createRes.text()).toBe(201);
  const agentId = ((await createRes.json()) as { id: string }).id;

  const patchRes = await page.request.patch(`/api/agents/${agentId}`, {
    data: { allowedTools: KB_EVAL_ALLOWED_TOOLS },
  });
  expect(patchRes.status(), await patchRes.text()).toBe(200);

  await waitForOpenClawStable(async () => {
    const r = await page.request.get("/api/health/openclaw");
    return { ok: r.ok(), json: () => r.json() };
  });
  await waitForAgentDispatchable(
    async (id) => {
      const r = await page.request.get(`/api/health/openclaw?agentId=${id}`);
      return { ok: r.ok(), json: () => r.json() };
    },
    agentId,
    { deadlineMs: 120_000 }
  );

  return { agentId };
}

/** Deletes the agent created by `setupKbAgent`. `page` must be authenticated. */
export async function teardownKbAgent(page: Page, agentId: string): Promise<void> {
  if (!agentId) return;
  await login(page);
  await page.request.delete(`/api/agents/${agentId}`);
}
