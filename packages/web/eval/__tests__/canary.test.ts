import { describe, expect, it } from "vitest";
import { EVAL_CANARY_GUID, EVAL_CANARY_JSONL_LINE, isCanaryLine, parseEvalJsonl } from "../canary";

describe("eval canary constant", () => {
  it("is a fixed lowercase UUID", () => {
    expect(EVAL_CANARY_GUID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("carries the GUID inside a single-line valid-JSON header record", () => {
    expect(EVAL_CANARY_JSONL_LINE).not.toContain("\n");
    const parsed = JSON.parse(EVAL_CANARY_JSONL_LINE) as { __canary__?: string };
    expect(parsed.__canary__).toContain(EVAL_CANARY_GUID);
    // BIG-bench-style opt-out phrasing so responsible trainers can filter us out.
    expect(parsed.__canary__).toMatch(/should never appear in training/i);
  });
});

describe("isCanaryLine", () => {
  it("recognizes the canary header line", () => {
    expect(isCanaryLine(EVAL_CANARY_JSONL_LINE)).toBe(true);
  });

  it("does not flag an ordinary RunResult line", () => {
    const run = JSON.stringify({
      model: "ollama-cloud/kimi-k2.6",
      passed: true,
      tags: [],
      notes: [],
      latencyMs: 141014,
      scenario: "hetzner-invoice-rejected-models",
    });
    expect(isCanaryLine(run)).toBe(false);
  });
});

describe("parseEvalJsonl", () => {
  it("skips the canary header and blank lines, parsing the remaining records", () => {
    const text = [
      EVAL_CANARY_JSONL_LINE,
      JSON.stringify({ model: "a", passed: true }),
      "",
      JSON.stringify({ model: "b", passed: false }),
      "",
    ].join("\n");

    const rows = parseEvalJsonl<{ model: string; passed: boolean }>(text);

    expect(rows).toEqual([
      { model: "a", passed: true },
      { model: "b", passed: false },
    ]);
  });

  it("returns an empty array for a canary-only file", () => {
    expect(parseEvalJsonl(`${EVAL_CANARY_JSONL_LINE}\n`)).toEqual([]);
  });
});
