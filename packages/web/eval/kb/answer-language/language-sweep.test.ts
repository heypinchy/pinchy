import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EVAL_CANARY_GUID } from "../../canary";
import { gradeAnswerLanguage } from "../../../src/lib/eval/kb/answer-language";
import {
  DEFAULT_LANGUAGE_CANDIDATES,
  languageCandidatesFromEnv,
  languageConditionFromEnv,
  pendingLanguageRuns,
  summarizeLanguageRuns,
  type LanguageRunRow,
} from "./language-sweep";
import { LANGUAGE_QUESTIONS } from "./questions";

function row(over: Partial<LanguageRunRow>): LanguageRunRow {
  return {
    condition: "after",
    model: "anthropic/claude-haiku-5-5",
    questionId: "pl-temperature",
    lang: "pl",
    passed: true,
    found: ["pl"],
    reminderInToolResult: true,
    mentioned: true,
    answer: "…",
    latencyMs: 1,
    at: "2026-11-05T00:00:00.000Z",
    ...over,
  };
}

describe("languageCandidatesFromEnv", () => {
  it("defaults to the two models #1296 compares", () => {
    expect(languageCandidatesFromEnv({})).toEqual(DEFAULT_LANGUAGE_CANDIDATES);
    expect(DEFAULT_LANGUAGE_CANDIDATES).toEqual([
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("accepts an override naming catalog models of either provider", () => {
    expect(
      languageCandidatesFromEnv({
        EVAL_CANDIDATE_MODELS: "anthropic/claude-sonnet-5, ollama-cloud/kimi-k2.6",
      })
    ).toEqual(["anthropic/claude-sonnet-5", "ollama-cloud/kimi-k2.6"]);
  });

  it("refuses an id the catalog does not serve before any key is spent", () => {
    expect(() =>
      languageCandidatesFromEnv({ EVAL_CANDIDATE_MODELS: "anthropic/claude-haiku-9" })
    ).toThrow(/anthropic\/claude-haiku-9/);
    expect(() => languageCandidatesFromEnv({ EVAL_CANDIDATE_MODELS: "claude-haiku-5-5" })).toThrow(
      /claude-haiku-5-5/
    );
  });

  it("refuses an empty override", () => {
    expect(() => languageCandidatesFromEnv({ EVAL_CANDIDATE_MODELS: " , " })).toThrow(/empty/);
  });
});

describe("languageConditionFromEnv", () => {
  it("requires a condition label, because rows from both conditions share one file", () => {
    expect(() => languageConditionFromEnv({})).toThrow(/KB_LANG_EVAL_CONDITION/);
    expect(languageConditionFromEnv({ KB_LANG_EVAL_CONDITION: "before" })).toBe("before");
  });

  it("refuses a label that is not a plain slug", () => {
    expect(() => languageConditionFromEnv({ KB_LANG_EVAL_CONDITION: "after fix" })).toThrow();
  });
});

describe("pendingLanguageRuns", () => {
  it("counts only rows of the same condition, so a resumed run tops up what is missing", () => {
    const existing = [
      row({ condition: "before" }),
      row({ condition: "after" }),
      row({ condition: "after" }),
    ];
    const pending = pendingLanguageRuns(
      existing,
      "after",
      ["anthropic/claude-haiku-5-5"],
      ["pl-temperature", "pl-signature"],
      3
    );
    expect(pending).toEqual([
      { model: "anthropic/claude-haiku-5-5", questionId: "pl-temperature" },
      { model: "anthropic/claude-haiku-5-5", questionId: "pl-signature" },
      { model: "anthropic/claude-haiku-5-5", questionId: "pl-signature" },
      { model: "anthropic/claude-haiku-5-5", questionId: "pl-signature" },
    ]);
  });

  it("does not count an infra error as a done run", () => {
    const existing = [row({ infraError: "dispatch timed out", passed: false, found: [] })];
    expect(
      pendingLanguageRuns(existing, "after", ["anthropic/claude-haiku-5-5"], ["pl-temperature"], 1)
    ).toHaveLength(1);
  });
});

describe("summarizeLanguageRuns", () => {
  it("reports passes per condition, model and question language, leaving infra errors out", () => {
    const summary = summarizeLanguageRuns([
      row({ passed: false, found: ["de"] }),
      row({ passed: true }),
      row({ lang: "en", questionId: "en-temperature", passed: true, found: ["en"] }),
      row({ infraError: "boom", passed: false, found: [] }),
    ]);
    expect(summary).toEqual([
      {
        condition: "after",
        model: "anthropic/claude-haiku-5-5",
        lang: "en",
        passed: 1,
        n: 1,
        mentioned: 1,
      },
      {
        condition: "after",
        model: "anthropic/claude-haiku-5-5",
        lang: "pl",
        passed: 1,
        n: 2,
        mentioned: 2,
      },
    ]);
  });
});

describe("the cross-lingual question set", () => {
  it("carries the contamination canary", () => {
    const text = readFileSync(path.join(__dirname, "questions.ts"), "utf8");
    expect(text).toContain(EVAL_CANARY_GUID);
  });

  it("asks in Polish, Italian and English, none of them the documents' language", () => {
    const langs = new Set(LANGUAGE_QUESTIONS.map((q) => q.lang));
    expect([...langs].sort()).toEqual(["en", "it", "pl"]);
  });

  it("has unique ids", () => {
    const ids = LANGUAGE_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads the corpus documents as German, so every answer must cross a language", () => {
    // If a document stopped reading as German, a correct answer could come
    // from text already in the question's language and the sweep would stop
    // measuring the failure #1296 is about.
    const docsDir = path.join(__dirname, "docs");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(docsDir);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      expect(gradeAnswerLanguage(readFileSync(file, "utf8"), "de").passed, file).toBe(true);
    }
  });
});
