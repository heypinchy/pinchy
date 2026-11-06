// Cross-lingual answer sweep (#1296): does a Knowledge Base agent answer in
// the user's language when every passage it retrieves is German?
//
// German-only documents (`docs/`) go through the stack's real ingest
// pipeline, and a fresh Knowledge Base agent answers each question in
// `questions.ts`. The verdict reads only the answer's language
// (`gradeAnswerLanguage`), so no judge model is involved and no Ollama Cloud
// key is needed for the default Anthropic candidates.
//
// Local-only and paid, like the other sweeps: no per-run assertions, resumable
// JSONL in `eval/kb/results/`, one row per run, a summary at the end.
//
//   ANTHROPIC_API_KEY=… KB_LANG_EVAL_CONDITION=after EVAL_N=3 pnpm kb-eval:language
//
// It shells out to `docker` twice, because there is no API for either step:
// once to put the documents into the shared `/data` volume, and once to read
// which knowledge_search plugin the OpenClaw container actually runs. The
// second one stamps every row, so a "before" run that measured the fixed
// plugin can't pass for a baseline.
import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  seedSetup,
  waitForPinchy,
  login,
  pinchyGet,
  pinchyPost,
  pinchyPatch,
  pinchyPut,
} from "../../../e2e/odoo/helpers";
import { getAdminEmail, getAdminPassword } from "../../../e2e/email/helpers";
import {
  loginViaUI,
  waitForOpenClawStable,
  waitForAgentDispatchable,
} from "../../../e2e/shared/dispatch-probe";
import { stackDbUrl } from "../../../e2e/shared/stack-db";
import { dispatchAndScrape, pinAgentModel } from "../../run-eval";
import { runsPerModelFromEnv } from "../run-kb-eval";
import { getRawAssistantMessage } from "../getRawAssistantMessage";
import { describeError } from "../../error-detail";
import { gradeAnswerLanguage } from "../../../src/lib/eval/kb/answer-language";
import { buildKbSweepAgentPayload, KB_SWEEP_ALLOWED_TOOLS } from "../sweep-agent";
import {
  AGENTS_MD_LANGUAGE_SECTION,
  GERMAN_IDENTITY,
  GERMAN_INSTRUCTIONS_SECTION,
  GERMAN_WARMUP_QUESTION,
  assertConditionMatchesVariant,
  isWarmupEcho,
  sameLanguageWarmupQuestion,
  LANGUAGE_SWEEP_LABEL,
  languageCandidatesFromEnv,
  languageConditionFromEnv,
  pendingLanguageRuns,
  summarizeLanguageRuns,
  type LanguageRunRow,
} from "./language-sweep";
import { LANGUAGE_QUESTIONS } from "./questions";

const DOCS_DIR = path.join(__dirname, "docs");
const CORPUS_ROOT = "/data/kb-language";
const RESULTS_FILE = path.join(__dirname, "..", "results", `${LANGUAGE_SWEEP_LABEL}.jsonl`);
const OPENCLAW_CONTAINER = process.env.KB_LANG_EVAL_OPENCLAW_CONTAINER || "pinchy-eval-openclaw-1";
const PLUGIN_SOURCE = "/root/.openclaw/extensions/pinchy-knowledge/index.ts";
const REMINDER_MARKER = "Write your answer in the language of the user's question";

function pdfCount(dir = DOCS_DIR): number {
  return readdirSync(dir).reduce((n, entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return n + pdfCount(full);
    return n + (full.endsWith(".pdf") ? 1 : 0);
  }, 0);
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" });
}

function pluginSha(): string {
  return docker(["exec", OPENCLAW_CONTAINER, "sha256sum", PLUGIN_SOURCE]).split(" ")[0] ?? "";
}

function pluginCarriesReminder(): boolean {
  return docker(["exec", OPENCLAW_CONTAINER, "cat", PLUGIN_SOURCE]).includes(REMINDER_MARKER);
}

async function readRows(): Promise<LanguageRunRow[]> {
  const text = await readFile(RESULTS_FILE, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LanguageRunRow);
}

async function appendRow(row: LanguageRunRow): Promise<void> {
  await mkdir(path.dirname(RESULTS_FILE), { recursive: true });
  await appendFile(RESULTS_FILE, JSON.stringify(row) + "\n");
}

async function seedAnthropicKey(dbUrl: string): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return; // without a key, Anthropic dispatches fail and land as infra-error rows
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);
  try {
    await sql`
      INSERT INTO settings (key, value, encrypted) VALUES ('anthropic_api_key', ${key}, false)
      ON CONFLICT (key) DO UPDATE SET value = ${key}
    `;
  } finally {
    await sql.end();
  }
}

/** The tools `agentId` called since `since`, oldest first, from the audit trail. */
async function toolCallsSince(cookie: string, agentId: string, since: string): Promise<string[]> {
  const qs = new URLSearchParams({ from: since, limit: "100" });
  const res = await pinchyGet(`/api/audit?${qs.toString()}`, cookie);
  if (!res.ok) throw new Error(`Audit query failed: ${String(res.status)}`);
  const body = (await res.json()) as {
    entries: Array<{ eventType: string; resource: string | null; timestamp: string }>;
  };
  return body.entries
    .filter((e) => e.resource === `agent:${agentId}` && e.eventType.startsWith("tool."))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((e) => e.eventType.slice("tool.".length));
}

/** Appends `section` to the agent's AGENTS.md. */
async function appendAgentsMdSection(
  cookie: string,
  agentId: string,
  section: string
): Promise<void> {
  const getRes = await pinchyGet(`/api/agents/${agentId}/files/AGENTS.md`, cookie);
  if (!getRes.ok) throw new Error(`Failed to read AGENTS.md: ${String(getRes.status)}`);
  const { content } = (await getRes.json()) as { content: string };
  const putRes = await pinchyPut(
    `/api/agents/${agentId}/files/AGENTS.md`,
    { content: `${content.trimEnd()}\n\n${section}\n` },
    cookie
  );
  if (!putRes.ok) {
    throw new Error(`Failed to write AGENTS.md: ${String(putRes.status)} ${await putRes.text()}`);
  }
}

/** Creates the Knowledge Base agent over the German corpus and indexes it. */
async function setupAgent(cookie: string, germanIdentity: boolean): Promise<string> {
  const payload = {
    ...buildKbSweepAgentPayload(
      germanIdentity ? GERMAN_IDENTITY.name : `KB-Language-${Date.now()}`
    ),
    pluginConfig: { "pinchy-files": { allowed_paths: [CORPUS_ROOT] } },
  };
  const createRes = await pinchyPost("/api/agents", payload, cookie);
  if (!createRes.ok) {
    throw new Error(
      `Failed to create agent: ${String(createRes.status)} ${await createRes.text()}`
    );
  }
  const { id: agentId } = (await createRes.json()) as { id: string };

  const patchRes = await pinchyPatch(
    `/api/agents/${agentId}`,
    {
      allowedTools: KB_SWEEP_ALLOWED_TOOLS,
      pluginConfig: { "pinchy-files": { allowed_paths: [CORPUS_ROOT] } },
      ...(germanIdentity ? { tagline: GERMAN_IDENTITY.tagline } : {}),
    },
    cookie
  );
  if (!patchRes.ok) {
    throw new Error(`Failed to grant tools: ${String(patchRes.status)} ${await patchRes.text()}`);
  }

  const reindexRes = await pinchyPost(`/api/agents/${agentId}/knowledge/reindex`, {}, cookie);
  if (!reindexRes.ok) {
    throw new Error(
      `Failed to start indexing: ${String(reindexRes.status)} ${await reindexRes.text()}`
    );
  }
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const res = await pinchyGet(`/api/agents/${agentId}/knowledge/reindex`, cookie);
    const body = (await res.json()) as {
      job: { status: string; counts: { indexed: number; skipped: number } | null } | null;
    };
    if (body.job?.status === "succeeded") {
      // A run that found nothing still "succeeds", and the sweep would then
      // grade abstentions over an empty index. The first dry run did exactly
      // that, with Markdown files the pipeline does not ingest.
      const searchable = (body.job.counts?.indexed ?? 0) + (body.job.counts?.skipped ?? 0);
      if (searchable < pdfCount()) {
        throw new Error(
          `Indexed ${String(searchable)} of ${String(pdfCount())} documents: ${JSON.stringify(body)}`
        );
      }
      break;
    }
    if (body.job?.status === "failed") throw new Error(`Indexing failed: ${JSON.stringify(body)}`);
    if (Date.now() > deadline) throw new Error(`Indexing did not finish: ${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  return agentId;
}

test.describe("KB cross-lingual answer sweep (#1296)", () => {
  test("answers German sources in the language of the question", async ({ page }) => {
    test.setTimeout(Number(process.env.EVAL_TEST_TIMEOUT_MS) || 6 * 60 * 60_000);

    const condition = languageConditionFromEnv(process.env);
    const candidates = languageCandidatesFromEnv(process.env);
    const n = runsPerModelFromEnv(1);
    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5437);

    await seedSetup();
    await waitForPinchy();
    await seedAnthropicKey(dbUrl);
    const cookie = await login();

    // Emptied first: `docker cp` adds files but never removes one, and a
    // document renamed here would otherwise stay indexed under its old name.
    docker(["exec", OPENCLAW_CONTAINER, "rm", "-rf", CORPUS_ROOT]);
    docker(["exec", OPENCLAW_CONTAINER, "mkdir", "-p", CORPUS_ROOT]);
    docker(["cp", `${DOCS_DIR}/.`, `${OPENCLAW_CONTAINER}:${CORPUS_ROOT}`]);
    // Only the PDFs are the corpus. The Markdown next to them is their source,
    // and an agent that can list the folder would read it instead of searching.
    docker(["exec", OPENCLAW_CONTAINER, "find", CORPUS_ROOT, "-name", "*.md", "-delete"]);
    const reminderInToolResult = pluginCarriesReminder();
    const pluginStamp = pluginSha();
    console.log(
      `[kb-language] condition=${condition} reminderInToolResult=${String(reminderInToolResult)}`
    );

    const germanIdentity = process.env.KB_LANG_EVAL_GERMAN_IDENTITY === "1";
    const agentId = await setupAgent(cookie, germanIdentity);
    const agentsMdLanguageSection = process.env.KB_LANG_EVAL_AGENTS_MD_SECTION === "1";
    const germanInstructions = process.env.KB_LANG_EVAL_GERMAN_INSTRUCTIONS === "1";
    const germanWarmup = process.env.KB_LANG_EVAL_GERMAN_WARMUP === "1";
    const sameLanguageWarmup = process.env.KB_LANG_EVAL_SAME_LANGUAGE_WARMUP === "1";
    if (germanInstructions) {
      await appendAgentsMdSection(cookie, agentId, GERMAN_INSTRUCTIONS_SECTION);
    }
    if (agentsMdLanguageSection) {
      await appendAgentsMdSection(cookie, agentId, AGENTS_MD_LANGUAGE_SECTION);
    }
    await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));

    const existing = await readRows();
    assertConditionMatchesVariant(existing, condition, {
      reminderInToolResult,
      pluginSha: pluginStamp,
      agentsMdLanguageSection,
      germanIdentity,
      germanInstructions,
      germanWarmup,
      sameLanguageWarmup,
    });
    const pending = pendingLanguageRuns(
      existing,
      condition,
      candidates,
      LANGUAGE_QUESTIONS.map((q) => q.id),
      n
    );

    let pinned: string | null = null;
    for (const { model, questionId } of pending) {
      const question = LANGUAGE_QUESTIONS.find((q) => q.id === questionId);
      if (!question) throw new Error(`Unknown question id in pending runs: ${questionId}`);
      if (pinned !== model) {
        await pinAgentModel(cookie, agentId, model);
        await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));
        await waitForAgentDispatchable(
          (id: string) => pinchyGet(`/api/health/openclaw?agentId=${id}`, cookie),
          agentId
        );
        pinned = model;
      }

      const start = Date.now();
      const base = {
        condition,
        model,
        questionId,
        lang: question.lang,
        reminderInToolResult,
        pluginSha: pluginStamp,
        agentsMdLanguageSection,
        germanIdentity,
        germanInstructions,
        germanWarmup,
        sameLanguageWarmup,
        at: new Date().toISOString(),
      };
      try {
        await loginViaUI(page, getAdminEmail(), getAdminPassword());
        const chatId = randomUUID();
        let since = new Date().toISOString();
        let warmupAnswer: string | null = null;
        const warmupQuestion = germanWarmup
          ? GERMAN_WARMUP_QUESTION
          : sameLanguageWarmup
            ? sameLanguageWarmupQuestion(LANGUAGE_QUESTIONS, question)
            : null;
        if (warmupQuestion) {
          await dispatchAndScrape(page, agentId, warmupQuestion, {
            chatId,
            idleTimeoutMs: 120_000,
          });
          warmupAnswer = await getRawAssistantMessage(page, agentId, chatId);
          since = new Date().toISOString();
        }
        await dispatchAndScrape(page, agentId, question.query, { chatId, idleTimeoutMs: 120_000 });
        const answer = await getRawAssistantMessage(page, agentId, chatId);
        if (isWarmupEcho(answer, warmupAnswer)) {
          throw new Error("captured the warmup's answer: the question's turn produced no text");
        }
        const toolCalls = await toolCallsSince(cookie, agentId, since);
        const verdict = gradeAnswerLanguage(answer, question.lang);
        await appendRow({
          ...base,
          passed: verdict.passed,
          found: verdict.found,
          toolCalls,
          mentioned: question.mentions.test(answer),
          answer,
          latencyMs: Date.now() - start,
        });
        console.log(
          `[kb-language] ${model} ${questionId}: ${verdict.passed ? "PASS" : "FAIL"} ` +
            `found=${verdict.found.join(",") || "-"} tools=${toolCalls.join(",") || "-"}`
        );
      } catch (err) {
        console.warn(`[kb-language] ${model} ${questionId}: infra error ${describeError(err)}`);
        await appendRow({
          ...base,
          passed: false,
          found: [],
          toolCalls: [],
          mentioned: false,
          answer: "",
          latencyMs: Date.now() - start,
          infraError: describeError(err),
        });
      }
    }

    console.log("[kb-language] summary:");
    console.table(summarizeLanguageRuns(await readRows()));
  });
});
