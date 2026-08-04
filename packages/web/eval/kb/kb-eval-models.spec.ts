// packages/web/eval/kb/kb-eval-models.spec.ts
//
// KB Eval Harness Task 3.4 — Layer 3 stochastic groundedness SWEEP against
// real Ollama Cloud candidate models. Per (candidate model, gold Q/A):
// dispatches the gold query to a fresh KB agent, captures the RAW assistant
// text (getRawAssistantMessage.ts — NOT a DOM scrape, see its doc comment),
// grades it with `gradeKbRun` (attribution + groundedness + relevance +
// citation-correctness), and appends the graded `KbRunResult` (+ trajectory)
// to `results/<label>.{jsonl,trajectories.jsonl}`, writing a scorecard at the
// end. Mirrors `../eval-models.spec.ts`'s shape (resumable, NO per-run
// assertions — this measures model behavior, it does not gate CI on it;
// timeout -> a graded run-timeout row, never a crashed sweep).
//
// Run with `OLLAMA_CLOUD_API_KEY=... pnpm kb-eval:models` (see the
// `kb-eval:models` script in package.json — routes to THIS file the same way
// `eval:models` routes to `eval-models.spec.ts`, via
// `playwright.eval.config.ts`'s testMatch).
//
// NEEDS VALIDATION AGAINST THE RUNNING STACK (orchestrator's dry-run — NOT
// run from this task, no key available here). Every piece below is read from
// source, not observed live:
//   1. (NO LONGER UNVALIDATED) Corpus seeding now lives in `seed-corpus.ts`
//      and is covered by `kb-eval-seed-corpus.integration.test.ts` against a
//      real Postgres. It was broken in two ways while this note called it
//      unvalidated: it INSERTed a `page` column that does not exist (the
//      locator is jsonb), which killed every sweep 200ms in, and it hard-coded
//      status 'active', which would have seeded the archived `OLD/` copy as
//      current and made the freshness axis (#858) grade the opposite of what
//      it asks.
//   2. The agent grant shape (`allowedTools: ["knowledge_search"]` +
//      `pluginConfig["pinchy-files"].allowed_paths`) — mirrors
//      `e2e/integration/agent-chat.spec.ts`'s pinchy-knowledge probe, not
//      re-verified here against a live OpenClaw config regen.
//   3. `getRawAssistantMessage`'s two-call capture (chats list ->
//      diagnostics export) — see that file's own "NEEDS VALIDATION" note.
//   4. `createOllamaCloudChatFn`'s judge wiring (llm-nli.ts) — needs a real
//      key + confirming the pinned judge model id is available.
//   5. (NO LONGER UNVALIDATED) `fetchChunkTexts`'s raw SQL against `kb_chunks`
//      for the groundedness premise material now lives in `chunk-texts.ts` and
//      is covered by `kb-eval-chunk-texts.integration.test.ts` against a real
//      Postgres. It was broken the whole time this note called it unvalidated
//      (#869): `sql.array(...)` on the right side of `ANY` throws, so the
//      premise material never loaded.
import { test } from "@playwright/test";
import { randomUUID } from "node:crypto";

import {
  seedSetup,
  waitForPinchy,
  login,
  pinchyGet,
  pinchyPost,
  pinchyPatch,
  pinchyDelete,
} from "../../e2e/odoo/helpers";
import { getAdminEmail, getAdminPassword } from "../../e2e/email/helpers";
import {
  loginViaUI,
  waitForOpenClawStable,
  waitForAgentDispatchable,
} from "../../e2e/shared/dispatch-probe";
import { stackDbUrl } from "../../e2e/shared/stack-db";
import { dispatchAndScrape } from "../run-eval";
import {
  requireOllamaCloudApiKey,
  candidateModelsFromEnv,
  runsPerModelFromEnv,
  pinAgentModel,
  appendRunResult,
  appendTrajectory,
  readExistingRuns,
  writeScorecard,
  pendingPairs,
  corpusFromEnv,
  noackCorpusDir,
  retrievedSourcesFromAuditEntries,
  infraErrorRun,
  sweepShouldAbort,
} from "./run-kb-eval";
import type { KnowledgeSearchAuditEntry } from "./run-kb-eval";
import { getRawAssistantMessage } from "./getRawAssistantMessage";
import { gradeKbRun } from "../../src/lib/eval/kb/answer-graders";
import type { KbRunTrajectory, KbRunResult } from "../../src/lib/eval/kb/answer-graders";
import {
  DEFAULT_KB_JUDGE_MODEL,
  LlmNliClient,
  LlmRelevanceJudge,
  createOllamaCloudChatFn,
} from "../../src/lib/eval/kb/llm-nli";
import { DEFAULT_ORG_ID } from "../../src/lib/knowledge/constants";
import { fetchChunkTexts } from "./chunk-texts";
import { seedSyntheticCorpus } from "./seed-corpus";
import { premiseSourcePaths } from "./resolve-cited-paths";
import { withTransportRetry } from "../transport-retry";
import { describeError } from "../error-detail";
import { DEFAULT_KB_CANDIDATES } from "../candidates";
import {
  KB_SWEEP_ALLOWED_TOOLS,
  KB_SWEEP_CORPUS_ROOT,
  KB_SWEEP_TEMPLATE_ID,
  buildKbSweepAgentPayload,
  missingSweepSkills,
} from "./sweep-agent";
import { getTemplate } from "../../src/lib/agent-templates/registry";
import { GOLD_QA } from "./corpus/gold-qa";

const RESULT_LABEL = "kb-groundedness-sweep";

/**
 * The (local-only, guarded) real Noack corpus path. `corpusFromEnv()` already
 * enforces the opt-in (KB_EVAL_CORPUS_DIR set, never in CI) before this is
 * ever called — see run-kb-eval.ts's doc comments. NOT WIRED TO A REAL
 * INGEST PIPELINE in this task: the synthetic corpus's committed-embeddings
 * seeding above deliberately avoids a live embedder, but the Noack corpus is
 * real, non-public content with no committed embeddings fixture (by design —
 * it must never be checked in), so seeding it for real requires the full
 * `ingestDirectory` pipeline (`src/lib/knowledge/ingest.ts`) with a live
 * embedder, run from INSIDE the stack (that module imports `@/db`, which
 * binds to whatever `DATABASE_URL` is in ITS process — not necessarily this
 * external Playwright process's `stackDbUrl`-mapped port). Left as an
 * explicit, loud failure rather than a silent no-op corpus so a `--corpus=
 * noack` run never quietly measures against an empty index. Wiring a real
 * local ingest path is follow-up work, not required for Task 3.4's keyless
 * code (the orchestrator's dry-run only exercises `--corpus=synthetic`).
 */
function seedNoackCorpus(): never {
  const dir = noackCorpusDir();
  throw new Error(
    `--corpus=noack (KB_EVAL_CORPUS_DIR=${dir}) has no wired ingest path in this harness yet — ` +
      "seeding real Noack documents requires running src/lib/knowledge/ingest.ts's ingestDirectory " +
      "from inside the stack (it binds to @/db) with a live embedder, not this external Playwright " +
      "process. Use --corpus=synthetic (default) for the harness's own committed corpus."
  );
}

/**
 * Creates a fresh **Knowledge Base** agent scoped to `knowledge_search` + the
 * eval corpus root, waits for it to be dispatchable.
 *
 * The template is the measurement, not a detail: it is what brings in the
 * cite-then-answer instructions the graders enforce — today through the
 * `knowledge-search` skill it declares, which agent creation copies onto the
 * agent row. See `sweep-agent.ts` for why a bare `custom` agent made the first
 * sweep unreadable (#869 item 4).
 */
async function setupKbSweepAgent(cookie: string): Promise<{ agentId: string }> {
  const createRes = await pinchyPost(
    "/api/agents",
    buildKbSweepAgentPayload(`KB-Sweep-${Date.now()}`),
    cookie
  );
  if (!createRes.ok) {
    // Quote the body, not just the status. A bare "400" is what this threw
    // when the payload was missing `allowed_paths`, and the route had said
    // "At least one directory must be selected" the whole time — the one
    // sentence that would have named the fix.
    throw new Error(
      `Failed to create KB sweep agent: ${String(createRes.status)} ${await createRes.text()}`
    );
  }
  const { id: agentId } = (await createRes.json()) as { id: string };

  const patchRes = await pinchyPatch(
    `/api/agents/${agentId}`,
    {
      allowedTools: KB_SWEEP_ALLOWED_TOOLS,
      pluginConfig: { "pinchy-files": { allowed_paths: [KB_SWEEP_CORPUS_ROOT] } },
    },
    cookie
  );
  if (!patchRes.ok) {
    throw new Error(
      `Failed to grant knowledge_search to KB sweep agent: ${String(patchRes.status)} ` +
        (await patchRes.text())
    );
  }

  // Verify the measurement premise on THIS agent before measuring anything.
  // The cited-answer contract the graders enforce arrives through the
  // template's skill; if the agent did not receive it, every groundedness
  // number this run produces describes an agent that was never told the rules
  // — which is exactly how the first sweep published a passRate of 0 (#869).
  // Fail loudly here rather than 8 minutes later as a scorecard nobody can
  // interpret.
  const agentRes = await pinchyGet(`/api/agents/${agentId}`, cookie);
  if (!agentRes.ok) {
    throw new Error(
      `Failed to read back KB sweep agent: ${String(agentRes.status)} ${await agentRes.text()}`
    );
  }
  const agent = (await agentRes.json()) as { skills?: string[] | null };
  const templateSkills = getTemplate(KB_SWEEP_TEMPLATE_ID)?.defaultSkills ?? [];
  const missing = missingSweepSkills(templateSkills, agent.skills);
  if (missing.length > 0) {
    throw new Error(
      `KB sweep agent ${agentId} is missing the skill(s) that state the cited-answer ` +
        `contract: ${missing.join(", ")}. Grading its answers would measure whether the ` +
        `model invents an unstated contract, not whether it stays grounded.`
    );
  }

  await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));
  await waitForAgentDispatchable(
    (id: string) => pinchyGet(`/api/health/openclaw?agentId=${id}`, cookie),
    agentId,
    {
      deadlineMs: 120_000,
    }
  );

  return { agentId };
}

/**
 * Collects every `tool.knowledge_search` audit row for `agentId` since
 * `since` — mirrors `../run-eval.ts`'s `collectToolAuditEntries`, scoped to
 * the one tool this harness's agent is granted.
 */
async function collectKnowledgeSearchAuditEntries(
  cookie: string,
  agentId: string,
  since: string
): Promise<KnowledgeSearchAuditEntry[]> {
  const qs = new URLSearchParams({ eventType: "tool.knowledge_search", from: since, limit: "50" });
  const res = await pinchyGet(`/api/audit?${qs.toString()}`, cookie);
  if (!res.ok)
    throw new Error(`Audit query failed for tool.knowledge_search: ${String(res.status)}`);
  const body = (await res.json()) as {
    entries: Array<{ resource: string | null; detail: unknown }>;
  };
  return body.entries
    .filter((e) => e.resource === `agent:${agentId}`)
    .map((e) => ({ detail: e.detail }));
}

test.describe("KB Eval Harness Layer 3: groundedness sweep (real Ollama Cloud)", () => {
  test("sweeps candidate models over the gold Q/A set and writes a groundedness scorecard", async ({
    page,
  }) => {
    // Long-running, resumable — mirrors ../eval-models.spec.ts's 24h default budget.
    test.setTimeout(Number(process.env.EVAL_TEST_TIMEOUT_MS) || 24 * 60 * 60_000);

    const corpus = corpusFromEnv();

    await seedSetup();
    await waitForPinchy();
    const cookie = await login();

    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5437);

    // Same key-seeding pattern as ../eval-models.spec.ts: prefer the env key,
    // fall back to whatever is already stored so an unattended watchdog can
    // resume with no secret in its own environment.
    const { default: postgres } = await import("postgres");
    const sql = postgres(dbUrl);
    const envKey = process.env.OLLAMA_CLOUD_API_KEY?.trim();
    let ollamaKey: string;
    if (envKey) {
      await sql`
        INSERT INTO settings (key, value, encrypted) VALUES ('ollama_cloud_api_key', ${envKey}, false)
        ON CONFLICT (key) DO UPDATE SET value = ${envKey}
      `;
      ollamaKey = envKey;
    } else {
      const rows = await sql`SELECT value FROM settings WHERE key = 'ollama_cloud_api_key'`;
      if (rows.length === 0) {
        await sql.end();
        requireOllamaCloudApiKey(); // throws with the standard actionable message
        throw new Error("unreachable");
      }
      ollamaKey = rows[0].value as string;
    }
    await sql`
      INSERT INTO settings (key, value, encrypted) VALUES ('default_provider', 'ollama-cloud', false)
      ON CONFLICT (key) DO UPDATE SET value = 'ollama-cloud'
    `;
    await sql.end();

    if (corpus === "synthetic") {
      await seedSyntheticCorpus(dbUrl);
    } else {
      seedNoackCorpus(); // always throws — see its doc comment.
    }

    const candidates = candidateModelsFromEnv(DEFAULT_KB_CANDIDATES);
    const n = runsPerModelFromEnv(1);
    const goldIds = GOLD_QA.map((g) => g.id);

    const { agentId } = await setupKbSweepAgent(cookie);

    // The LLM-as-NLI judge + relevance judge (llm-nli.ts) — a pinned,
    // separate model from the candidates under test, same reasoning as
    // groundedness-grader.ts's DEFAULT_TAU comment: keep the JUDGE fixed so
    // score drift over a long sweep reflects the candidate's behavior, not
    // the judge's. The default lives in llm-nli.ts (one literal, checked
    // against the catalog by sweep-candidates.test.ts); override per run with
    // KB_EVAL_JUDGE_MODEL.
    const judgeModel = process.env.KB_EVAL_JUDGE_MODEL || DEFAULT_KB_JUDGE_MODEL;
    const chat = createOllamaCloudChatFn({ apiKey: ollamaKey, model: judgeModel });
    const nli = new LlmNliClient(chat);
    const relevance = new LlmRelevanceJudge(chat);

    const withRetry = async (fn: () => Promise<void>, what: string): Promise<void> => {
      const attempts = 4;
      for (let a = 1; a <= attempts; a++) {
        try {
          await fn();
          return;
        } catch (e) {
          if (a === attempts) throw e;
          console.warn(
            `[kb-eval] ${what} attempt ${String(a)}/${String(attempts)} failed, retrying: ${String(e)}`
          );
          await new Promise((r) => setTimeout(r, 8000));
        }
      }
    };

    const existingRuns = await readExistingRuns(RESULT_LABEL);
    const allRuns: KbRunResult[] = [...existingRuns];

    let pinnedModel: string | null = null;
    // A dead endpoint is not 48 bad runs, it is one bad endpoint. Now that a
    // transport fault is retried, each pair costs the full ~9-minute backoff
    // before it gives up — roughly seven hours across a whole sweep, and every
    // pair comes out with an infra-error row that `pendingPairs` counts as
    // done, so a later resume never revisits it. Stopping leaves the rest
    // UNSTARTED, which resume handles perfectly. Reset on any completed run.
    let consecutiveInfraErrors = 0;
    for (const { model, goldId } of pendingPairs(existingRuns, candidates, goldIds, n)) {
      const gold = GOLD_QA.find((g) => g.id === goldId);
      if (!gold) throw new Error(`Unknown gold id in pendingPairs: ${goldId}`);

      if (pinnedModel !== model) {
        const setupStart = Date.now();
        try {
          await withRetry(async () => {
            await pinAgentModel(cookie, agentId, model);
            await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));
            await waitForAgentDispatchable(
              (id: string) => pinchyGet(`/api/health/openclaw?agentId=${id}`, cookie),
              agentId
            );
          }, `setup ${model}`);
          pinnedModel = model;
        } catch (err) {
          // Setup (pin + dispatchable) failed after retries — a
          // harness/transport failure, not model quality. Record it as a
          // run-infra-error row for THIS (model, goldId) pair so the failure is
          // visible in the on-disk record and `excludedInfraErrors` instead of
          // the model silently vanishing from the scorecard. `scorecardRuns`/
          // the exporter exclude it from n, so it never counts as a model
          // failure. A model that fails setup on every goldId thus leaves one
          // infra-error row per pair (each pair re-enters this block, since
          // `pinnedModel` was never advanced to it).
          console.warn(
            `[kb-eval] setup failed for ${model}/${goldId} after retries, recording run-infra-error: ${describeError(err)}`
          );
          const setupErrorRun = infraErrorRun(model, goldId, err, Date.now() - setupStart);
          allRuns.push(setupErrorRun);
          await appendRunResult(RESULT_LABEL, setupErrorRun);
          consecutiveInfraErrors++;
          if (sweepShouldAbort(consecutiveInfraErrors)) break;
          continue;
        }
      }

      const runStart = Date.now();
      try {
        // Dispatch and grading retry SEPARATELY, and only across a transport
        // fault. The uplink can drop at either end of this block and the two
        // cost very different things: re-dispatching after a judge blip throws
        // away a good answer and a minute of model time, while resuming a
        // half-dispatched chat would grade a conversation the model already
        // started answering. So each attempt mints its own chatId, and the
        // judge retries on its own. `isTransportError` keeps a real defect —
        // no assistant text, a grader disagreement — out of the retry entirely
        // (#869: 15 of 48 runs lost to one offline stretch).
        const { answer, auditEntries, attemptStart } = await withTransportRetry(
          async () => {
            // Stamped INSIDE the attempt, not at `runStart` above. The
            // trajectory's latency is a model measurement, and a start taken
            // outside this call would charge the model for every failed
            // attempt plus the whole backoff — up to nine minutes of waiting
            // out a dead uplink, landing in `medianLatencyMs`. At the sweep's
            // default of one run per model, that single number IS the cell:
            // the network would be booked as a model result, which is the one
            // thing this retry exists to prevent. `runStart` still bounds the
            // infra-error row below, where the whole ordeal IS the story.
            const attemptStart = Date.now();
            await loginViaUI(page, getAdminEmail(), getAdminPassword());
            const chatId = randomUUID();
            const since = new Date().toISOString();
            await dispatchAndScrape(page, agentId, gold.query, { chatId, idleTimeoutMs: 120_000 });
            const [answer, auditEntries] = await Promise.all([
              getRawAssistantMessage(page, agentId, chatId),
              collectKnowledgeSearchAuditEntries(cookie, agentId, since),
            ]);
            return { answer, auditEntries, attemptStart };
          },
          { what: `dispatch ${model}/${goldId}` }
        );

        const retrieved = retrievedSourcesFromAuditEntries(auditEntries);
        // The answer cites what the tool SHOWED (a path relative to the data
        // root); kb_chunks is keyed by the absolute path. Resolving between
        // them against this run's own retrieved set is what makes the premise
        // lookup find anything at all — see resolve-cited-paths.ts.
        const citedPaths = premiseSourcePaths(answer, retrieved);
        const chunkTextsByPath = await fetchChunkTexts(dbUrl, DEFAULT_ORG_ID, citedPaths);
        const citedPassageTexts = citedPaths.flatMap((p) => chunkTextsByPath.get(p) ?? []);

        const trajectory: KbRunTrajectory = {
          model,
          query: gold.query,
          answer,
          retrieved,
          citedPassageTexts,
          latencyMs: Date.now() - attemptStart,
        };

        // The judge is an Ollama Cloud call, so it fails exactly when the
        // dispatch above does — but by this point the answer is already in
        // hand and re-dispatching to recover it would be pure waste.
        const result = await withTransportRetry(
          () => gradeKbRun(trajectory, gold, { nli, relevance }),
          { what: `judge ${model}/${goldId}` }
        );
        const stampedResult: KbRunResult = { ...result, scenario: goldId };
        allRuns.push(stampedResult);
        await appendRunResult(RESULT_LABEL, stampedResult);
        // A completed run — graded pass OR fail — proves the endpoints are
        // reachable, so the breaker's streak starts over.
        consecutiveInfraErrors = 0;
        await appendTrajectory(RESULT_LABEL, goldId, trajectory, result.passed, result.tags).catch(
          (err) =>
            console.warn(`[kb-eval] trajectory dump failed for ${model}/${goldId}: ${String(err)}`)
        );
      } catch (err) {
        // A hung/looping run, a capture failure, or any per-run error must
        // NOT abort the whole sweep — record it as a graded `run-infra-error`
        // row and keep going, mirroring ../eval-models.spec.ts's run-timeout
        // handling. The TAG is what the scorecard reads: `run-infra-error` is
        // an invalid trial (harness/transport failure, not model behavior), so
        // export-kb-scorecard.ts EXCLUDES it from a cell's n — exactly as the
        // invoice ../export-scorecard.ts excludes its own `run-infra-error`.
        // The descriptive note is kept for the trajectory/forensics, but a run
        // left untagged would be silently counted as a model failure in
        // passRate and would zero passCaretK, conflating harness flakiness
        // with model quality.
        console.warn(
          `[kb-eval] run for ${model}/${goldId} recorded as run-infra-error: ${describeError(err)}`
        );
        const infraErrorResult = infraErrorRun(model, goldId, err, Date.now() - runStart);
        allRuns.push(infraErrorResult);
        await appendRunResult(RESULT_LABEL, infraErrorResult);
        consecutiveInfraErrors++;
        if (sweepShouldAbort(consecutiveInfraErrors)) {
          console.error(
            `[kb-eval] ABORTING SWEEP: ${String(consecutiveInfraErrors)} consecutive ` +
              `run-infra-errors — the endpoint is gone, not the run. The scorecard below ` +
              `covers what was measured; every pair not yet attempted stays pending and ` +
              `is picked up by the next run. Last failure: ${describeError(err)}`
          );
          break;
        }
      }
    }

    const scorecard = await writeScorecard(RESULT_LABEL, allRuns);
    console.log(
      `[kb-eval] wrote scorecard "${RESULT_LABEL}" for ${String(allRuns.length)} runs:`,
      scorecard
    );

    await pinchyDelete(`/api/agents/${agentId}`, cookie);
  });
});
