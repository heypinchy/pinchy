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
//   1. Corpus seeding (seedSyntheticCorpus) — raw SQL INSERTs against
//      kb_documents/kb_chunks with the committed bge-m3 embeddings fixture,
//      mirroring `kb-retrieval-eval.integration.test.ts`'s Drizzle-based
//      seeding but via the `postgres` package + stackDbUrl (this file runs
//      as an external Playwright spec against a docker-mapped port, not
//      inside the Next.js process — see `../eval-models.spec.ts`'s identical
//      DB-access pattern for its settings seeding).
//   2. The agent grant shape (`allowedTools: ["knowledge_search"]` +
//      `pluginConfig["pinchy-files"].allowed_paths`) — mirrors
//      `e2e/integration/agent-chat.spec.ts`'s pinchy-knowledge probe, not
//      re-verified here against a live OpenClaw config regen.
//   3. `getRawAssistantMessage`'s two-call capture (chats list ->
//      diagnostics export) — see that file's own "NEEDS VALIDATION" note.
//   4. `createOllamaCloudChatFn`'s judge wiring (llm-nli.ts) — needs a real
//      key + confirming the pinned judge model id is available.
//   5. `fetchChunkTexts`'s raw SQL against `kb_chunks` for the groundedness
//      premise material.
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
} from "../e2e/odoo/helpers";
import { getAdminEmail, getAdminPassword } from "../e2e/email/helpers";
import {
  loginViaUI,
  waitForOpenClawStable,
  waitForAgentDispatchable,
} from "../e2e/shared/dispatch-probe";
import { stackDbUrl } from "../e2e/shared/stack-db";
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
} from "./run-kb-eval";
import type { KnowledgeSearchAuditEntry } from "./run-kb-eval";
import { getRawAssistantMessage } from "./getRawAssistantMessage";
import { gradeKbRun } from "../../src/lib/eval/kb/answer-graders";
import type { KbRunTrajectory, KbRunResult } from "../../src/lib/eval/kb/answer-graders";
import { citedSourcePaths } from "../../src/lib/eval/kb/attribution-graders";
import {
  LlmNliClient,
  LlmRelevanceJudge,
  createOllamaCloudChatFn,
} from "../../src/lib/eval/kb/llm-nli";
import { DEFAULT_ORG_ID } from "../../src/lib/knowledge/constants";
import { KB_EVAL_CORPUS } from "./corpus/manifest";
import { GOLD_QA } from "./corpus/gold-qa";
import { loadEmbeddings } from "./embeddings-fixture";

const RESULT_LABEL = "kb-groundedness-sweep";

// The KB Layer-3 candidate set. Deliberately a SMALLER list than the
// invoice sweep's `DEFAULT_CANDIDATES` (`../eval-models.spec.ts`) — the
// groundedness gate is per-sentence NLI-judged, k=3 by default
// (`nli.ts`'s `DEFAULT_NLI_K`), against every GOLD_QA item, so the call
// count multiplies fast (models x goldQAs x sentences x k). Override with
// EVAL_CANDIDATE_MODELS, same env var the invoice sweep reads
// (`candidateModelsFromEnv`).
const DEFAULT_KB_CANDIDATES = [
  "ollama-cloud/kimi-k2.6",
  "ollama-cloud/glm-4.7",
  "ollama-cloud/qwen3.5:397b",
  "ollama-cloud/gpt-oss:120b",
];

const KB_ALLOWED_TOOLS = ["knowledge_search"];
const CORPUS_ROOT = "/data";

/**
 * Seeds `KB_EVAL_CORPUS` (`./corpus/manifest.ts`) into the live stack's
 * Postgres via raw SQL, using the COMMITTED bge-m3 embeddings fixture
 * (`./embeddings-fixture.ts`) — the same fixture Layer 1's
 * `kb-retrieval-eval.integration.test.ts` uses, so chunk embeddings need no
 * live embedder call. The real `retrieve()` (invoked through
 * `POST /api/internal/knowledge/search` when the agent's `knowledge_search`
 * tool fires) still calls a live embedder for the QUERY at search time —
 * that dependency is unchanged, this only removes it from CORPUS ingestion.
 * `orgId` MUST be `DEFAULT_ORG_ID` ("default") — the real route hardcodes
 * this single-tenant seam (`src/lib/knowledge/constants.ts`), unlike the
 * Layer-1 vitest suite's isolated `"org-kb-eval"` test-DB constant.
 */
async function seedSyntheticCorpus(dbUrl: string): Promise<void> {
  const embeddings = loadEmbeddings();
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);
  try {
    for (const doc of KB_EVAL_CORPUS) {
      const [dbDoc] = await sql<{ id: string }[]>`
        INSERT INTO kb_documents (org_id, content_hash, source_path, status)
        VALUES (${DEFAULT_ORG_ID}, ${`hash-${doc.sourcePath}`}, ${doc.sourcePath}, 'active')
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      // A prior sweep invocation may have already seeded this doc (ON
      // CONFLICT DO NOTHING then returns no row) — re-select rather than
      // re-insert chunks on top of an existing document.
      const dbDocId =
        dbDoc?.id ??
        (
          await sql<{ id: string }[]>`
            SELECT id FROM kb_documents WHERE org_id = ${DEFAULT_ORG_ID} AND source_path = ${doc.sourcePath}
          `
        )[0]?.id;
      if (!dbDocId) throw new Error(`Failed to resolve kb_documents.id for ${doc.sourcePath}`);

      for (const chunk of doc.chunks) {
        const embedding = embeddings.chunks[chunk.id];
        if (!embedding) {
          throw new Error(
            `Missing embedding fixture for chunk id ${chunk.id} — run pnpm kb-eval:reembed`
          );
        }
        const existing = await sql<{ id: string }[]>`
          SELECT id FROM kb_chunks WHERE document_id = ${dbDocId} AND chunk_text = ${chunk.text}
        `;
        if (existing.length > 0) continue; // already seeded by a prior invocation
        // pgvector's textual literal is the same `[1,2,3]` form JSON.stringify
        // produces for a number array — see src/lib/knowledge/retrieve.ts's
        // identical `${queryVectorLiteral}::vector` pattern.
        await sql`
          INSERT INTO kb_chunks (document_id, org_id, source_path, chunk_text, page, embedding)
          VALUES (${dbDocId}, ${DEFAULT_ORG_ID}, ${doc.sourcePath}, ${chunk.text}, ${chunk.page}, ${JSON.stringify(embedding)}::vector)
        `;
      }
    }
  } finally {
    await sql.end();
  }
}

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
 * Fetches every chunk's `chunk_text` for the given `sourcePaths`, keyed by
 * path — the groundedness premise material for whichever sources the
 * answer's Sources list actually cited (`citedSourcePaths`, not the full
 * retrieved set — see that function's doc comment for why). A direct SELECT
 * against the already-seeded corpus, not a re-run of `retrieve()`: we
 * already know exactly which paths were retrieved (from the audit row), so
 * this needs no new search/embedding call, only the stored text.
 */
async function fetchChunkTexts(
  dbUrl: string,
  sourcePaths: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (sourcePaths.length === 0) return map;

  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);
  try {
    const rows = await sql<{ source_path: string; chunk_text: string }[]>`
      SELECT source_path, chunk_text FROM kb_chunks
      WHERE org_id = ${DEFAULT_ORG_ID} AND source_path = ANY(${sql.array(sourcePaths)})
    `;
    for (const row of rows) {
      const texts = map.get(row.source_path) ?? [];
      texts.push(row.chunk_text);
      map.set(row.source_path, texts);
    }
    return map;
  } finally {
    await sql.end();
  }
}

/** Creates a fresh custom agent scoped to `knowledge_search` + the eval corpus root, waits for it to be dispatchable. */
async function setupKbSweepAgent(cookie: string): Promise<{ agentId: string }> {
  const createRes = await pinchyPost(
    "/api/agents",
    { name: `KB-Sweep-${Date.now()}`, templateId: "custom" },
    cookie
  );
  if (!createRes.ok)
    throw new Error(`Failed to create KB sweep agent: ${String(createRes.status)}`);
  const { id: agentId } = (await createRes.json()) as { id: string };

  const patchRes = await pinchyPatch(
    `/api/agents/${agentId}`,
    {
      allowedTools: KB_ALLOWED_TOOLS,
      pluginConfig: { "pinchy-files": { allowed_paths: [CORPUS_ROOT] } },
    },
    cookie
  );
  if (!patchRes.ok) {
    throw new Error(
      `Failed to grant knowledge_search to KB sweep agent: ${String(patchRes.status)}`
    );
  }

  await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));
  await waitForAgentDispatchable(
    (id) => pinchyGet(`/api/health/openclaw?agentId=${id}`, cookie),
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
    // the judge's. Overridable via KB_EVAL_JUDGE_MODEL.
    const judgeModel = process.env.KB_EVAL_JUDGE_MODEL || "ollama-cloud/gpt-oss:20b";
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
    for (const { model, goldId } of pendingPairs(existingRuns, candidates, goldIds, n)) {
      const gold = GOLD_QA.find((g) => g.id === goldId);
      if (!gold) throw new Error(`Unknown gold id in pendingPairs: ${goldId}`);

      if (pinnedModel !== model) {
        try {
          await withRetry(async () => {
            await pinAgentModel(cookie, agentId, model);
            await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));
            await waitForAgentDispatchable(
              (id) => pinchyGet(`/api/health/openclaw?agentId=${id}`, cookie),
              agentId
            );
          }, `setup ${model}`);
          pinnedModel = model;
        } catch (err) {
          console.warn(
            `[kb-eval] SKIPPING model ${model} entirely — setup failed after retries: ${String(err)}`
          );
          continue;
        }
      }

      const runStart = Date.now();
      const chatId = randomUUID();
      try {
        await loginViaUI(page, getAdminEmail(), getAdminPassword());

        const since = new Date().toISOString();
        await dispatchAndScrape(page, agentId, gold.query, { chatId, idleTimeoutMs: 120_000 });

        const [answer, auditEntries] = await Promise.all([
          getRawAssistantMessage(page, agentId, chatId),
          collectKnowledgeSearchAuditEntries(cookie, agentId, since),
        ]);

        const retrieved = retrievedSourcesFromAuditEntries(auditEntries);
        const citedPaths = citedSourcePaths(answer);
        const chunkTextsByPath = await fetchChunkTexts(dbUrl, citedPaths);
        const citedPassageTexts = citedPaths.flatMap((p) => chunkTextsByPath.get(p) ?? []);

        const trajectory: KbRunTrajectory = {
          model,
          query: gold.query,
          answer,
          retrieved,
          citedPassageTexts,
          latencyMs: Date.now() - runStart,
        };

        const result = await gradeKbRun(trajectory, gold, { nli, relevance });
        const stampedResult: KbRunResult = { ...result, scenario: goldId };
        allRuns.push(stampedResult);
        await appendRunResult(RESULT_LABEL, stampedResult);
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
        const latencyMs = Date.now() - runStart;
        console.warn(
          `[kb-eval] run for ${model}/${goldId} recorded as run-infra-error: ${String(err)}`
        );
        const infraErrorResult: KbRunResult = {
          model,
          scenario: goldId,
          passed: false,
          tags: ["run-infra-error"],
          notes: [`[run-infra-error] ${String(err)}`],
          latencyMs,
        };
        allRuns.push(infraErrorResult);
        await appendRunResult(RESULT_LABEL, infraErrorResult);
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
