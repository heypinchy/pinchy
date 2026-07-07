// packages/web/eval/run-eval.ts
//
// Eval-v1 orchestrator (pinchy#669): drives the Hetzner-invoice scenario
// end-to-end against a real Pinchy/OpenClaw stack for N runs per candidate
// model, grades each run with the pure graders in
// `packages/web/src/lib/eval/graders.ts` (via the normalizer), and writes a
// scorecard. Two modes:
//
//   - "selftest": deterministic, no paid API — dispatches against the
//     in-repo fake-ollama server using the Hetzner self-test triggers (see
//     fake-ollama-server.ts) and ASSERTS the happy run grades pass and the
//     false-success run grades fail. Safe to run in CI.
//   - "models": dispatches against real Ollama Cloud models. Requires
//     OLLAMA_CLOUD_API_KEY. Collects RunResults and writes a scorecard —
//     no per-run assertions (model behavior is what's being measured, not
//     asserted against).
//
// This module contains the orchestration logic as plain async functions
// taking a Playwright `Page` + API helpers, so it is importable from a
// Playwright spec (packages/web/eval/eval.spec.ts) without embedding
// `test`/`expect` calls itself.
import type { Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildTrajectory, type NormalizeAuditEntry } from "../src/lib/eval/normalize";
import { gradeRun } from "../src/lib/eval/graders";
import { buildScorecard, type ScorecardEntry } from "../src/lib/eval/scorecard";
import type { OdooMoveRecord, RunResult } from "../src/lib/eval/types";
import { hetznerInvoiceScenario } from "./scenarios/hetzner-invoice";

const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";
const MOCK_ODOO_URL = process.env.MOCK_ODOO_URL || "http://localhost:9002";

export const RESULTS_DIR = path.join(__dirname, "results");

// ── HTTP helpers (mirrors packages/web/e2e/*/helpers.ts pinchy* helpers) ───

function mutatingHeaders(cookie: string): Record<string, string> {
  return { "Content-Type": "application/json", Cookie: cookie, Origin: PINCHY_URL };
}

export async function pinchyGet(path: string, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, { method: "GET", headers: { Cookie: cookie } });
}

export async function pinchyPost(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "POST",
    headers: mutatingHeaders(cookie),
    body: JSON.stringify(body),
  });
}

export async function pinchyPatch(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "PATCH",
    headers: mutatingHeaders(cookie),
    body: JSON.stringify(body),
  });
}

export async function pinchyPut(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "PUT",
    headers: mutatingHeaders(cookie),
    body: JSON.stringify(body),
  });
}

// ── Odoo mock helpers ────────────────────────────────────────────────────

export async function resetOdooMock(): Promise<void> {
  const res = await fetch(`${MOCK_ODOO_URL}/control/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to reset Odoo mock: ${res.status}`);
}

export async function seedOdooRecords(
  model: string,
  records: Record<string, unknown>[]
): Promise<void> {
  const res = await fetch(`${MOCK_ODOO_URL}/control/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, records }),
  });
  if (!res.ok) throw new Error(`Failed to seed Odoo records: ${res.status}`);
}

export async function getOdooRecords(model: string): Promise<OdooMoveRecord[]> {
  const res = await fetch(`${MOCK_ODOO_URL}/control/records?model=${encodeURIComponent(model)}`);
  if (!res.ok) throw new Error(`Failed to get Odoo records: ${res.status}`);
  return (await res.json()) as OdooMoveRecord[];
}

/** Seeds every model/records pair from the scenario's Odoo baseline. */
export async function seedOdooBaseline(
  baseline: typeof hetznerInvoiceScenario.odooBaseline
): Promise<void> {
  for (const { model, records } of baseline) {
    await seedOdooRecords(model, records);
  }
}

// ── Audit collection ─────────────────────────────────────────────────────

/**
 * Tool names the Hetzner scenario can dispatch. `GET /api/audit` only
 * supports an EXACT `eventType` match (packages/web/src/app/api/audit/route.ts
 * — `eq(auditLog.eventType, eventType)`, no prefix/LIKE), so collecting every
 * `tool.*` row for a run means querying once per known tool name and
 * merging, rather than a single `eventType=tool.` prefix query.
 */
export const HETZNER_SCENARIO_TOOL_NAMES = [
  "email_list",
  "email_search",
  "email_read",
  "email_get_attachment",
  "odoo_create",
] as const;

interface AuditApiEntry {
  resource: string | null;
  eventType: string;
  outcome: "success" | "failure";
  detail: unknown;
  timestamp: string | number;
  error: { message: string } | null;
}

/**
 * Collects every `tool.<name>` audit row for `agentId` since `since`, across
 * all tool names the scenario can dispatch, merged into one array. See
 * HETZNER_SCENARIO_TOOL_NAMES for why this can't be a single prefix query.
 */
export async function collectToolAuditEntries(
  cookie: string,
  agentId: string,
  since: string
): Promise<NormalizeAuditEntry[]> {
  const merged: NormalizeAuditEntry[] = [];

  for (const toolName of HETZNER_SCENARIO_TOOL_NAMES) {
    const qs = new URLSearchParams({
      eventType: `tool.${toolName}`,
      from: since,
      limit: "100",
    });
    const res = await pinchyGet(`/api/audit?${qs.toString()}`, cookie);
    if (!res.ok) {
      throw new Error(`Audit query failed for tool.${toolName}: ${String(res.status)}`);
    }
    const body = (await res.json()) as { entries: AuditApiEntry[] };
    for (const entry of body.entries) {
      if (entry.resource !== `agent:${agentId}`) continue;
      merged.push({
        eventType: entry.eventType,
        outcome: entry.outcome,
        detail: entry.detail as NormalizeAuditEntry["detail"],
        timestamp: entry.timestamp,
      });
    }
  }

  return merged;
}

// ── Chat dispatch + scrape ──────────────────────────────────────────────
//
// NEEDS VALIDATION AGAINST THE RUNNING STACK: the assistant-message
// selector (`[data-role="assistant"]`, from
// packages/web/src/components/assistant-ui/thread.tsx) and the idle signal
// (composer Send button reappears — `[aria-label="Send message"]` — once
// `thread.isRunning` goes false, per the same file) are read from source,
// not observed live. Confirm both against a real chat run before trusting
// scraped output for `models` mode.

/**
 * Waits for a dispatched run to finish. The composer swaps its Send button
 * for a "Stop generating" button while `thread.isRunning` is true, so we
 * FIRST wait for Stop to appear (run started) and THEN for it to disappear
 * (run finished). Waiting only for "Send message" to be visible would return
 * immediately — that button is already visible in the idle pre-dispatch
 * state, so the scrape would race ahead of the response.
 */
async function waitForRunIdle(page: Page, timeoutMs: number): Promise<void> {
  const stop = page.getByRole("button", { name: "Stop generating" });
  try {
    // A very fast run could start+finish before this poll catches Stop; a
    // short timeout keeps that case from stalling the whole idle wait.
    await stop.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    // Stop never observed visible — either the run finished extremely fast or
    // never started. Fall through to the hidden-wait, which resolves promptly
    // if Stop is already gone.
  }
  await stop.waitFor({ state: "hidden", timeout: timeoutMs });
}

/** Scrapes the text of the LAST assistant message bubble in the chat DOM. */
async function scrapeFinalAssistantMessage(page: Page): Promise<string> {
  const assistantMessages = page.locator('[data-role="assistant"]');
  const count = await assistantMessages.count();
  if (count === 0) return "";
  const last = assistantMessages.nth(count - 1);
  return (await last.innerText()).trim();
}

export interface DispatchResult {
  finalMessage: string;
  latencyMs: number;
}

/**
 * Dispatches `prompt` to `agentId` via the chat UI and waits for the run to
 * go idle, then scrapes the final assistant message. Assumes the caller has
 * already navigated `page` past login (loginViaUI) and to `/chat/<agentId>`.
 */
export async function dispatchAndScrape(
  page: Page,
  agentId: string,
  prompt: string,
  opts: { idleTimeoutMs?: number } = {}
): Promise<DispatchResult> {
  await page.goto(`/chat/${agentId}`);
  const input = page.getByPlaceholder(/send a message/i);
  await input.waitFor({ state: "visible", timeout: 10_000 });

  const start = Date.now();
  await input.fill(prompt);
  await input.press("Enter");

  await waitForRunIdle(page, opts.idleTimeoutMs ?? 300_000);
  const latencyMs = Date.now() - start;

  const finalMessage = await scrapeFinalAssistantMessage(page);
  return { finalMessage, latencyMs };
}

// ── Agent model pinning ──────────────────────────────────────────────────

/**
 * Pins `agentId`'s model to `model` (e.g. "ollama-cloud/kimi-k2.6") via
 * `PATCH /api/agents/:id`, bypassing the tier resolver.
 */
export async function pinAgentModel(cookie: string, agentId: string, model: string): Promise<void> {
  const res = await pinchyPatch(`/api/agents/${agentId}`, { model }, cookie);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to pin agent ${agentId} to model ${model}: ${res.status} ${text}`);
  }
}

// ── Single-run orchestration ─────────────────────────────────────────────

export interface RunOnceParams {
  page: Page;
  cookie: string;
  agentId: string;
  model: string;
  /**
   * Overrides the dispatched prompt. Defaults to the scenario's natural-
   * language `userPrompt`. The selftest mode passes a trigger-prefixed
   * variant (e.g. `${FAKE_OLLAMA_HETZNER_HAPPY_TRIGGER}: <userPrompt>`) so
   * fake-ollama's substring match engages while the grading logic below
   * stays identical between selftest and real-model runs.
   */
  prompt?: string;
}

/**
 * Runs the Hetzner scenario ONCE against an already-configured agent
 * (permissions + allowedTools + model already set by the caller) and
 * returns the graded RunResult. Does NOT reset/seed mocks or pin the model
 * — the caller does that once per model (mocks are reset/seeded per run;
 * see runEvalForModel below).
 */
export async function runOnce(params: RunOnceParams): Promise<RunResult> {
  const { page, cookie, agentId, model } = params;
  const since = new Date().toISOString();

  const { finalMessage, latencyMs } = await dispatchAndScrape(
    page,
    agentId,
    params.prompt ?? hetznerInvoiceScenario.userPrompt
  );

  const auditEntries = await collectToolAuditEntries(cookie, agentId, since);
  const odooMoves = await getOdooRecords("account.move");

  const trajectory = buildTrajectory({
    model,
    auditEntries,
    finalMessage,
    odooMoves,
    seededMessageId: hetznerInvoiceScenario.seededMessageId,
    seededAttachmentId: hetznerInvoiceScenario.seededAttachmentId,
    latencyMs,
  });

  return gradeRun(trajectory, hetznerInvoiceScenario.expected);
}

// ── Scorecard I/O ─────────────────────────────────────────────────────────

export async function writeScorecard(label: string, runs: RunResult[]): Promise<ScorecardEntry[]> {
  // Defense in depth: label is a hardcoded literal at every call site today,
  // but reject path separators/traversal so a future env-derived label can
  // never escape RESULTS_DIR.
  if (!/^[a-zA-Z0-9._-]+$/.test(label)) {
    throw new Error(`Invalid scorecard label (must be a plain filename segment): ${label}`);
  }

  const scorecard = buildScorecard(runs);
  await mkdir(RESULTS_DIR, { recursive: true });
  const filePath = path.join(RESULTS_DIR, `${label}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- label validated above (alnum/./_/- only, no path separators)
  await writeFile(
    filePath,
    JSON.stringify({ generatedAt: new Date().toISOString(), runs, scorecard }, null, 2),
    "utf8"
  );
  return scorecard;
}

// ── Models-mode guard ─────────────────────────────────────────────────────

export function requireOllamaCloudApiKey(): string {
  const key = process.env.OLLAMA_CLOUD_API_KEY;
  if (!key) {
    throw new Error(
      "OLLAMA_CLOUD_API_KEY is not set. The 'models' eval mode dispatches against real " +
        "Ollama Cloud models and requires a real API key. Set OLLAMA_CLOUD_API_KEY and re-run, " +
        "or use `pnpm eval:selftest` for the deterministic, no-key self-test."
    );
  }
  return key;
}

export function candidateModelsFromEnv(defaultModels: string[]): string[] {
  const raw = process.env.EVAL_CANDIDATE_MODELS;
  if (!raw) return defaultModels;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function runsPerModelFromEnv(defaultN: number): number {
  const raw = Number(process.env.EVAL_N);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : defaultN;
}
