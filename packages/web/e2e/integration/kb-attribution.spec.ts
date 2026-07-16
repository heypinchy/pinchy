// packages/web/e2e/integration/kb-attribution.spec.ts
//
// KB Eval Harness Task 2.3 — Layer-2 attribution SELF-TEST. Lives in
// e2e/integration/ on purpose: this directory is exactly what the existing
// `integration` CI job runs (`pnpm test:integration` =
// `playwright test --config playwright.integration.config.ts`, testDir
// "./e2e/integration"), so this spec is picked up automatically as part of
// that already-required check — no new CI job needed (that's Task 2.4,
// documentation only). It IS the Layer-2 attribution gate.
//
// Drives the REAL chat UI against the real production-image Pinchy +
// OpenClaw stack, with fake-ollama standing in for the LLM (keyless,
// deterministic — see e2e/shared/fake-ollama/fake-ollama-server.ts). One
// SHARED custom agent (Task 2.3 setup, kb-eval-shared.ts) is granted only
// `knowledge_search` and reused across all five triggers, mirroring the
// "Plugin behavior — pinchy-knowledge" dispatch-coverage probe in
// agent-chat.spec.ts.
//
// GRADING INPUT — deliberately the scripted RESPONSE constant, not the
// scraped DOM text: `gradeAttribution`'s parsers (`BULLET_LINE`,
// `SOURCES_HEADING` — attribution-graders.ts) match literal markdown syntax
// in the RAW answer text an LLM produces (e.g. a leading "- " before
// "[N]"), exactly as the grader's own unit tests
// (attribution-graders.test.ts) exercise it. But the chat UI renders that
// markdown through react-markdown + remark-gfm
// (markdown-text.tsx) into real `<ul><li>` elements — verified empirically
// (a `<ul><li>[1] /data/vacation-policy-en.md — p. 1</li></ul>` fixture's
// `.innerText` came back as `"[1] /data/vacation-policy-en.md — p. 1"`, with
// NO leading "- "). Grading the rendered/scraped text directly would make
// `BULLET_LINE` never match, so `parseSourcesEntries` would return zero
// entries for every bulleted fixture — corrupting ALL FIVE assertions
// (including WELL_FORMED, which must pass with zero tags) into false
// `sources-format` + `citation-unresolved` failures. The scrape therefore
// exists to prove the message actually round-tripped end-to-end through
// fake-ollama -> OpenClaw -> Pinchy -> the chat UI (a plain-prose substring
// sanity check, safe from markdown transformation), while `gradeAttribution`
// grades the RESPONSE constant fake-ollama is proven (by that same scrape)
// to have sent verbatim — the raw text a real Layer-3 harness would grade
// from chat history/audit, not a DOM rendering artifact.
import { test, expect } from "@playwright/test";
import {
  FAKE_OLLAMA_KB_WELL_FORMED_TRIGGER,
  FAKE_OLLAMA_KB_WELL_FORMED_RESPONSE,
  FAKE_OLLAMA_KB_UNLISTED_CITATION_TRIGGER,
  FAKE_OLLAMA_KB_UNLISTED_CITATION_RESPONSE,
  FAKE_OLLAMA_KB_UNCITED_SOURCE_TRIGGER,
  FAKE_OLLAMA_KB_UNCITED_SOURCE_RESPONSE,
  FAKE_OLLAMA_KB_BARE_FILENAME_TRIGGER,
  FAKE_OLLAMA_KB_BARE_FILENAME_RESPONSE,
  FAKE_OLLAMA_KB_RUNON_FORMAT_TRIGGER,
  FAKE_OLLAMA_KB_RUNON_FORMAT_RESPONSE,
} from "../shared/fake-ollama/fake-ollama-server";
import { login } from "./helpers";
import { setupKbAgent, teardownKbAgent } from "../../eval/kb/kb-eval-shared";
import { dispatchAndScrape } from "../../eval/run-eval";
import { gradeAttribution } from "../../src/lib/eval/kb/attribution-graders";
import type { RetrievedSource } from "../../src/lib/eval/kb/attribution-graders";
import type { KbGraderResult } from "../../src/lib/eval/kb/types";

// Per-trigger `retrieved` fixtures — see the docblock above
// KB_WELL_FORMED_TRIGGER in fake-ollama-server.ts for why each set is built
// this way (isolating the intended defect from an unrelated `retrieved` gap
// that would spuriously trip gradePathCitation).
const RETRIEVED_FIXTURES: Record<string, RetrievedSource[]> = {
  [FAKE_OLLAMA_KB_WELL_FORMED_TRIGGER]: [
    { n: 1, sourcePath: "/data/vacation-policy-en.md", page: 1 },
  ],
  [FAKE_OLLAMA_KB_UNLISTED_CITATION_TRIGGER]: [
    { n: 1, sourcePath: "/data/vacation-policy-en.md", page: 1 },
  ],
  [FAKE_OLLAMA_KB_UNCITED_SOURCE_TRIGGER]: [
    { n: 1, sourcePath: "/data/vacation-policy-en.md", page: 1 },
    { n: 2, sourcePath: "/data/quality-file.md", page: 2 },
  ],
  [FAKE_OLLAMA_KB_BARE_FILENAME_TRIGGER]: [
    { n: 1, sourcePath: "/data/product-insert.md", page: 2 },
  ],
  [FAKE_OLLAMA_KB_RUNON_FORMAT_TRIGGER]: [
    { n: 1, sourcePath: "/data/handbook-2012/policy.md", page: 1 },
  ],
};

/**
 * A plain-prose substring of each RESPONSE constant's BODY sentence,
 * containing no markdown control characters (no `*`, `-`, `#`) so it
 * survives react-markdown rendering unchanged — used to sanity-check that
 * the dispatched trigger actually produced the expected scripted answer in
 * the real chat UI, independent of the markdown-rendering caveat above.
 */
const SANITY_SUBSTRING: Record<string, string> = {
  [FAKE_OLLAMA_KB_WELL_FORMED_TRIGGER]:
    "The vacation policy grants 2.5 days of leave per month, capped at 30 days annually",
  [FAKE_OLLAMA_KB_UNLISTED_CITATION_TRIGGER]: "Employees accrue 2.5 days per month",
  [FAKE_OLLAMA_KB_UNCITED_SOURCE_TRIGGER]: "Employees accrue 2.5 days of leave per month",
  [FAKE_OLLAMA_KB_BARE_FILENAME_TRIGGER]:
    "The filter cartridge should be replaced every six months",
  [FAKE_OLLAMA_KB_RUNON_FORMAT_TRIGGER]: "The employee handbook requires an annual policy review",
};

interface Case {
  name: string;
  trigger: string;
  response: string;
  expectResult(result: KbGraderResult): void;
}

const CASES: Case[] = [
  {
    name: "well-formed answer passes every grader",
    trigger: FAKE_OLLAMA_KB_WELL_FORMED_TRIGGER,
    response: FAKE_OLLAMA_KB_WELL_FORMED_RESPONSE,
    expectResult: (result) => {
      expect(result.passed).toBe(true);
      expect(result.tags).toEqual([]);
    },
  },
  {
    name: "unlisted inline citation is caught (citation-unresolved)",
    trigger: FAKE_OLLAMA_KB_UNLISTED_CITATION_TRIGGER,
    response: FAKE_OLLAMA_KB_UNLISTED_CITATION_RESPONSE,
    expectResult: (result) => expect(result.tags).toContain("citation-unresolved"),
  },
  {
    name: "listed-but-uncited source is caught (source-uncited)",
    trigger: FAKE_OLLAMA_KB_UNCITED_SOURCE_TRIGGER,
    response: FAKE_OLLAMA_KB_UNCITED_SOURCE_RESPONSE,
    expectResult: (result) => expect(result.tags).toContain("source-uncited"),
  },
  {
    name: "bare filename citation is caught (path-not-cited)",
    trigger: FAKE_OLLAMA_KB_BARE_FILENAME_TRIGGER,
    response: FAKE_OLLAMA_KB_BARE_FILENAME_RESPONSE,
    expectResult: (result) => expect(result.tags).toContain("path-not-cited"),
  },
  {
    name: "run-on Sources list is caught (sources-format)",
    trigger: FAKE_OLLAMA_KB_RUNON_FORMAT_TRIGGER,
    response: FAKE_OLLAMA_KB_RUNON_FORMAT_RESPONSE,
    // A run-on list has no bulleted line at all, so the inline [1] ALSO
    // fails to resolve against the (empty) Sources list — this response
    // always grades as ["citation-unresolved", "sources-format"], never
    // "sources-format" alone (see the fake-ollama block comment). Assert
    // INCLUSION, not exact-tag equality.
    expectResult: (result) => expect(result.tags).toContain("sources-format"),
  },
];

test.describe.serial("KB Eval Harness — Layer-2 attribution self-test", () => {
  let agentId: string;

  test.beforeAll(async ({ browser }) => {
    // Setup grants a tool, waits for OC stability (up to 150s) and
    // dispatchability (up to 120s) — give it its own generous budget so the
    // five dispatch tests below stay focused, mirroring the pinchy-knowledge
    // probe's beforeAll in agent-chat.spec.ts.
    test.setTimeout(300_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const result = await setupKbAgent(page);
      agentId = result.agentId;
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!agentId) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await teardownKbAgent(page, agentId);
    } finally {
      await context.close();
    }
  });

  for (const kase of CASES) {
    test(kase.name, async ({ page }, testInfo) => {
      testInfo.setTimeout(180_000);
      await login(page);

      const { finalMessage } = await dispatchAndScrape(
        page,
        agentId,
        `${kase.trigger}: search the knowledge base`,
        { idleTimeoutMs: 60_000 }
      );

      // Sanity check: the scripted answer actually rendered in the real chat
      // UI (proves the fake-ollama -> OpenClaw -> Pinchy -> chat-UI
      // round-trip, independent of the markdown-rendering caveat above).
      expect(finalMessage).toContain(SANITY_SUBSTRING[kase.trigger]);

      // Grade the scripted RESPONSE constant fake-ollama is proven (by the
      // sanity check above) to have sent verbatim — see the module header
      // comment for why this, not the scraped/rendered text, is the correct
      // grading input.
      const result = gradeAttribution({
        answer: kase.response,
        retrieved: RETRIEVED_FIXTURES[kase.trigger],
        nearDuplicateGroups: [],
      });

      kase.expectResult(result);
    });
  }
});
