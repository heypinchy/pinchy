import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_CANARY_GUID, isCanaryLine } from "../canary";

/**
 * Read-side drift guard for the contamination canary (#794), a sibling of the
 * no-untracked-skips / no-test-deletion guards. It fails the moment a scenario
 * source or a published data file ships WITHOUT the canary — the exact hole
 * that lets a fresh scenario or a new sweep's dataset leak into a training
 * crawl unmarked, which is impossible to retrofit once crawled.
 */
const EVAL_DIR = path.join(__dirname, "..");
const SCENARIO_DIR = path.join(EVAL_DIR, "scenarios");
const DATA_DIR = path.join(EVAL_DIR, "data");

const scenarioFiles = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".ts"));
const dataFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith(".jsonl"));

describe("canary coverage over scenario sources", () => {
  it("has scenario files to guard", () => {
    expect(scenarioFiles.length).toBeGreaterThan(0);
  });

  it.each(scenarioFiles)("%s carries the canary GUID", (file) => {
    const text = readFileSync(path.join(SCENARIO_DIR, file), "utf8");
    expect(text).toContain(EVAL_CANARY_GUID);
  });
});

describe("canary coverage over published data files", () => {
  it("has data files to guard", () => {
    expect(dataFiles.length).toBeGreaterThan(0);
  });

  it.each(dataFiles)("%s begins with the canary header line", (file) => {
    const text = readFileSync(path.join(DATA_DIR, file), "utf8");
    const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
    expect(isCanaryLine(firstLine)).toBe(true);
  });
});
