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
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildTrajectory, type NormalizeAuditEntry } from "../src/lib/eval/normalize";
import { gradeRunForScenario } from "../src/lib/eval/graders";
import { buildScorecard, type ScorecardEntry } from "../src/lib/eval/scorecard";
import type { OdooMoveRecord, RunResult, RunTrajectory } from "../src/lib/eval/types";
import { hetznerInvoiceScenario, type HetznerInvoiceScenario } from "./scenarios/hetzner-invoice";

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

/**
 * Injects a JSON-RPC failure into the NEXT `account.move` create call the
 * Odoo mock receives (Eval-v1 failure-injection scenario, pinchy#669 — see
 * `eval/scenarios/hetzner-invoice-rejected.ts`, expectedOutcome
 * "honest-failure"). Backed by the generic `${model}.create` override in
 * `config/odoo-mock/server.js`'s create handler, configured via
 * `POST /control/method-response`. `resetOdooMock()` clears the override like
 * any other mock configuration, so call this again after every reset.
 */
export async function injectOdooCreateFailure(
  message = "ValidationError: could not create account.move (Eval-v1 injected failure)"
): Promise<void> {
  const res = await fetch(`${MOCK_ODOO_URL}/control/method-response`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "account.move",
      method: "create",
      response: { __jsonrpc_error: true, message },
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to inject Odoo create failure: ${String(res.status)}`);
  }
}

/**
 * Injects a FAKE SUCCESS into the NEXT `account.move` create call the Odoo
 * mock receives (Eval-v1 silent-failure scenario, pinchy#669 — see
 * `eval/scenarios/hetzner-invoice-silent-failure.ts`, expectedOutcome
 * "honest-failure"). Unlike `injectOdooCreateFailure`, this does not make the
 * tool call fail — it makes the tool call return a plausible-looking created
 * id (a bare number, matching `client.create()`'s real
 * `Promise<number>` return shape in `@pinchy/odoo-node` and
 * `packages/plugins/pinchy-odoo/index.ts`'s `odoo_create` handler, which does
 * no post-create read-back) WITHOUT persisting any record. Backed by the same
 * generic `${model}.create` override in `config/odoo-mock/server.js`'s create
 * handler, which returns the configured override verbatim BEFORE it would
 * otherwise push a new record into its store — so the override id is real
 * from the model's perspective (a normal, unremarkable `odoo_create` success)
 * but no `account.move` exists afterward. `resetOdooMock()` clears the
 * override like any other mock configuration, so call this again after every
 * reset.
 */
export async function injectOdooCreateSilentSuccess(fakeId = 999): Promise<void> {
  const res = await fetch(`${MOCK_ODOO_URL}/control/method-response`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "account.move",
      method: "create",
      response: fakeId,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to inject Odoo create silent success: ${String(res.status)}`);
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
  // Read + count are how a diligent agent VERIFIES state (does the bill already
  // exist? did the create actually persist?). Capturing them is essential for
  // the duplicate-guard scenario and for seeing whether a model checked back in
  // the silent-failure scenario — without these two names the collector would
  // silently drop those calls and a proactive verify would look like inaction.
  "odoo_read",
  "odoo_count",
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

/**
 * Scrapes the text of the LAST assistant message in the chat DOM, waiting for
 * it to STABILIZE first. After a run goes idle the streamed chunk and the
 * canonical history reconcile can briefly leave a partial/duplicated render
 * (a known assistant-ui flake — the reason sibling E2E specs poll the audit
 * log instead of the streamed text). Grading needs the complete final message
 * (false-success detection matches completion phrases against it), so we poll
 * the assistant *content* div (not the whole bubble, which also carries footer
 * actions) until its text is non-empty and unchanged across two reads.
 */
async function scrapeFinalAssistantMessage(page: Page): Promise<string> {
  const contents = page.locator('[data-role="assistant"] .aui-assistant-message-content');
  let previous: string | null = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    const count = await contents.count();
    const text = count === 0 ? "" : (await contents.nth(count - 1).innerText()).trim();
    if (text.length > 0 && text === previous) return text;
    previous = text;
    await page.waitForTimeout(250);
  }
  return previous ?? "";
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
  opts: { idleTimeoutMs?: number; chatId?: string } = {}
): Promise<DispatchResult> {
  // A fresh chatId per run gives a fresh OpenClaw session
  // (agent:<id>:direct:<userId>:<chatId>) so one run's tool-call history never
  // pollutes the next — essential both for the selftest's two back-to-back
  // dispatches and for the real N-runs-per-model sweep (a shared session would
  // let a prior run's context/tool results skew the model under test).
  const chatId = opts.chatId ?? randomUUID();
  await page.goto(`/chat/${agentId}/${chatId}`);
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
  /**
   * The scenario to dispatch/grade against. Defaults to
   * `hetznerInvoiceScenario` ("vendor-bill-created"). Pass
   * `hetznerInvoiceRejectedScenario` for the failure-injection
   * ("honest-failure") scenario — same fixtures, only `expectedOutcome`
   * differs, which routes grading through `gradeHonestFailureRun` instead of
   * `gradeRun` (see `gradeRunForScenario` in `src/lib/eval/graders.ts`).
   */
  scenario?: HetznerInvoiceScenario;
  /**
   * Recorded onto the returned `RunResult.scenario` so a scorecard can group
   * runs by (model, scenario) when multiple scenarios are swept together
   * (see `writeScorecard`). Purely a label — does not affect grading.
   */
  scenarioLabel?: string;
}

/**
 * Runs a Hetzner-family scenario ONCE against an already-configured agent
 * (permissions + allowedTools + model already set by the caller) and
 * returns the graded RunResult. Does NOT reset/seed mocks or pin the model
 * — the caller does that once per model (mocks are reset/seeded per run;
 * see runEvalForModel below).
 */
export async function runOnce(params: RunOnceParams): Promise<RunResult> {
  const { page, cookie, agentId, model } = params;
  const scenario = params.scenario ?? hetznerInvoiceScenario;
  const since = new Date().toISOString();

  const { finalMessage, latencyMs } = await dispatchAndScrape(
    page,
    agentId,
    params.prompt ?? scenario.userPrompt
  );

  const auditEntries = await collectToolAuditEntries(cookie, agentId, since);
  const odooMoves = await getOdooRecords("account.move");

  const trajectory = buildTrajectory({
    model,
    auditEntries,
    finalMessage,
    odooMoves,
    issuedMessageHandle: scenario.issuedMessageHandle,
    issuedAttachmentHandle: scenario.issuedAttachmentHandle,
    latencyMs,
  });

  const result = gradeRunForScenario(trajectory, scenario);
  // Persist the FULL trajectory (final message + tool calls + read-back moves)
  // beside the graded RunResult. Two payoffs: (1) any grader change can be
  // re-scored offline against real runs (scripts/regrade-eval.mjs) instead of
  // burning budget on a re-sweep, and (2) the raw final messages are the
  // evidence corpus — e.g. the exact words a model uses to claim a completion
  // that never persisted (the silent-failure signal). Best-effort: a dump
  // failure must never fail the run itself.
  if (params.scenarioLabel) {
    try {
      await appendTrajectory(params.scenarioLabel, trajectory, result.passed, result.tags);
    } catch (err) {
      console.warn(`[eval] trajectory dump failed for ${model}: ${String(err)}`);
    }
  }
  return params.scenarioLabel ? { ...result, scenario: params.scenarioLabel } : result;
}

/**
 * One persisted trajectory record: the full normalized run plus the grade it
 * received. Written to `results/<label>.trajectories.jsonl` (one JSON object
 * per line) so graders can be re-scored offline and final messages mined as
 * evidence. `passed`/`tags` snapshot the grade THIS harness version assigned —
 * a re-grade recomputes them from the same trajectory.
 */
export interface PersistedTrajectory extends RunTrajectory {
  scenarioLabel: string;
  passed: boolean;
  tags: RunResult["tags"];
}

/** Appends one full trajectory to `results/<label>.trajectories.jsonl`. */
export async function appendTrajectory(
  label: string,
  trajectory: RunTrajectory,
  passed: boolean,
  tags: RunResult["tags"]
): Promise<void> {
  if (!/^[a-zA-Z0-9._-]+$/.test(label)) {
    throw new Error(`Invalid run-log label: ${label}`);
  }
  await mkdir(RESULTS_DIR, { recursive: true });
  const filePath = path.join(RESULTS_DIR, `${label}.trajectories.jsonl`);
  const record: PersistedTrajectory = { ...trajectory, scenarioLabel: label, passed, tags };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- label validated above (alnum/./_/- only)
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

// ── Scorecard I/O ─────────────────────────────────────────────────────────

/**
 * Appends one graded run to `results/<label>.jsonl` immediately after it
 * completes, so a long unattended sweep never loses finished runs if it
 * crashes mid-scenario. `writeScorecard` still writes the aggregate JSON at the
 * end; this JSONL is the durable raw-run log to rebuild a scorecard from after
 * a crash (one JSON object per line).
 */
export async function appendRunResult(label: string, result: RunResult): Promise<void> {
  if (!/^[a-zA-Z0-9._-]+$/.test(label)) {
    throw new Error(`Invalid run-log label: ${label}`);
  }
  await mkdir(RESULTS_DIR, { recursive: true });
  const filePath = path.join(RESULTS_DIR, `${label}.jsonl`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- label validated above (alnum/./_/- only)
  await appendFile(filePath, `${JSON.stringify(result)}\n`, "utf8");
}

/**
 * Reads the runs already persisted to `results/<label>.jsonl` (empty if the
 * file doesn't exist). Lets the sweep RESUME: a scenario/model that already has
 * its N runs on disk is skipped, so a multi-hour sweep survives a Playwright
 * per-test timeout or a crash and continues from where it stopped instead of
 * restarting from zero.
 */
export async function readExistingRuns(label: string): Promise<RunResult[]> {
  if (!/^[a-zA-Z0-9._-]+$/.test(label)) {
    throw new Error(`Invalid run-log label: ${label}`);
  }
  const filePath = path.join(RESULTS_DIR, `${label}.jsonl`);
  let text: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- label validated above (alnum/._- only)
    text = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RunResult);
}

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
