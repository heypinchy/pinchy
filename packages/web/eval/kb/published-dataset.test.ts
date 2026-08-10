/**
 * Error-path coverage for the evidence reader.
 *
 * `data-reproducibility.test.ts` drives `readAllTrajectories` against the real
 * committed dataset, which proves it reads a HEALTHY file. That is the half
 * that cannot go wrong quietly. This file drives the other half — what the
 * reader does with input it cannot read — because the module's whole argument
 * for existing is that a short list of evidence reads exactly like evidence
 * that was checked and found clean.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readAllTrajectories, runKey } from "./published-dataset";
import { KB_EVAL_CANARY_JSONL_LINE } from "../canary";

const COMPLETE = {
  model: "ollama-cloud/test",
  query: "How often are laptops replaced?",
  answer: "Every three years [1].",
  retrieved: [{ n: 1, sourcePath: "/data/it-equipment-policy.md", page: null }],
  citedPassageTexts: ["Laptops are replaced every three years."],
  latencyMs: 1234,
  goldId: "gqa-happy-1",
  passed: true,
  tags: [],
};

describe("readAllTrajectories", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function dataDir(files: Record<string, string>): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "kb-trajectories-"));
    for (const [name, text] of Object.entries(files)) {
      await writeFile(path.join(dir, name), text, "utf8");
    }
    return dir;
  }

  it("reads trajectory lines and skips the canary header", async () => {
    const d = await dataDir({
      "sweep.trajectories.jsonl": `${KB_EVAL_CANARY_JSONL_LINE}\n${JSON.stringify(COMPLETE)}\n`,
      // The verdict file is the exporter's input, never this reader's.
      "sweep.jsonl": `${JSON.stringify({ model: "m", axis: "happy", passed: true, tags: [] })}\n`,
    });

    const trajectories = await readAllTrajectories(d);

    expect(trajectories).toHaveLength(1);
    expect(runKey(trajectories[0].model, trajectories[0].goldId)).toBe(
      "ollama-cloud/test::gqa-happy-1"
    );
  });

  it("names the file and line when a line is not valid JSON", async () => {
    // The realistic case, not a hypothetical: `appendFile` is not atomic, so a
    // sweep killed mid-write leaves a truncated last line — and `data/` is
    // filled by copying that file. A bare `SyntaxError: Unexpected end of JSON
    // input` names neither the file nor the line, which is precisely the
    // reader-that-cannot-say-what-it-choked-on this module exists to avoid.
    const d = await dataDir({
      "sweep.trajectories.jsonl": `${JSON.stringify(COMPLETE)}\n{"model":"m","goldId":`,
    });

    await expect(readAllTrajectories(d)).rejects.toThrow(/sweep\.trajectories\.jsonl line 2/);
  });

  it.each([
    ["model", { model: 1 }],
    ["goldId", { goldId: undefined }],
    ["answer", { answer: null }],
    ["retrieved", { retrieved: "not an array" }],
    ["tags", { tags: undefined }],
    // The four the type promises and the consumers read: `regrade-kb-runs.ts`
    // hands `query` and `latencyMs` straight to the judge, and the
    // reproducibility guard compares on `passed`. A predicate that asserts
    // `PublishedTrajectory` while checking five of its nine fields lets an
    // `undefined` question reach the judge and publishes the verdict.
    ["query", { query: undefined }],
    ["citedPassageTexts", { citedPassageTexts: null }],
    ["latencyMs", { latencyMs: "1234" }],
    ["passed", { passed: undefined }],
  ])("rejects a line whose %s is missing or the wrong type", async (_field, override) => {
    const d = await dataDir({
      "sweep.trajectories.jsonl": `${JSON.stringify({ ...COMPLETE, ...override })}\n`,
    });

    await expect(readAllTrajectories(d)).rejects.toThrow(/sweep\.trajectories\.jsonl line 1/);
  });

  it("returns no trajectories when the directory does not exist", async () => {
    expect(
      await readAllTrajectories(path.join(tmpdir(), "kb-trajectories-does-not-exist"))
    ).toEqual([]);
  });
});
