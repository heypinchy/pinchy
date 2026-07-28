// packages/web/src/__tests__/lib/plugin-tool-coverage-skips.test.ts
//
// Unit tests for the skip-aware scan behind the plugin-tool-coverage guard.
//
// The guard used to scan spec files as flat text, so a `eventType=tool.X`
// reference inside a permanently-skipped test counted as coverage for X. Two
// specs said so out loud — "skipped tests count for static scans" — and kept
// dead probes in the tree precisely to hold the guard green (#834). A guard
// that a never-running test satisfies reports on the presence of a string, not
// on the existence of a test.
import { describe, it, expect } from "vitest";
import { extractCoveredTools, skippedRanges } from "./plugin-tool-extraction";

describe("skippedRanges", () => {
  it("spans the whole test.skip call", () => {
    const source = `test.skip("a", async () => {\n  await probe();\n});\n`;
    const [range] = skippedRanges(source);
    expect(range).toBeDefined();
    expect(source.slice(range![0], range![1])).toContain("await probe()");
  });

  it("covers every skip syntax the skip policy names", () => {
    for (const call of [
      `test.skip("a", () => {})`,
      `it.skip("a", () => {})`,
      `describe.skip("a", () => {})`,
      `test.describe.skip("a", () => {})`,
      `it.todo("a")`,
      `test.fixme("a", () => {})`,
      `xit("a", () => {})`,
      `xdescribe("a", () => {})`,
    ]) {
      expect(skippedRanges(call), call).toHaveLength(1);
    }
  });

  it("leaves running tests and conditional gates alone", () => {
    const source = [
      `test("a", () => {});`,
      `describe.skipIf(!process.env.RUN)("b", () => {});`,
      `test.describe.serial("c", () => {});`,
    ].join("\n");
    expect(skippedRanges(source)).toEqual([]);
  });

  it("reports one range for a skipped describe, not one per nested test", () => {
    const source = `test.describe.skip("group", () => {\n  test("a", () => {});\n  test("b", () => {});\n});`;
    expect(skippedRanges(source)).toHaveLength(1);
  });
});

describe("extractCoveredTools", () => {
  it("counts a literal audit query in a running test", () => {
    const source = `test("a", async () => {\n  await page.request.get("/api/audit?eventType=tool.pinchy_ls&limit=10");\n});`;
    expect(extractCoveredTools(source)).toEqual(["pinchy_ls"]);
  });

  it("counts a pollAuditForTool call in a running test", () => {
    const source = `test("a", async () => {\n  await pollAuditForTool(page, { toolName: "pinchy_write", agentId });\n});`;
    expect(extractCoveredTools(source)).toEqual(["pinchy_write"]);
  });

  it("does NOT count a reference inside a skipped test", () => {
    const source = [
      `// tracked in #427`,
      `test.skip("probe", async () => {`,
      `  await page.request.get("/api/audit?eventType=tool.pinchy_ls&limit=10");`,
      `});`,
    ].join("\n");
    expect(extractCoveredTools(source)).toEqual([]);
  });

  it("does NOT count a reference inside a skipped describe block", () => {
    const source = [
      `test.describe.skip("workspace probe", () => {`,
      `  test("ls", async () => {`,
      `    const found = await pollAuditForTool(page, { toolName: "pinchy_ls", agentId });`,
      `  });`,
      `});`,
    ].join("\n");
    expect(extractCoveredTools(source)).toEqual([]);
  });

  it("keeps running siblings of a skipped test", () => {
    const source = [
      `test.skip("dead", async () => {`,
      `  await page.request.get("/api/audit?eventType=tool.pinchy_ls&limit=10");`,
      `});`,
      `test("alive", async () => {`,
      `  await pollAuditForTool(page, { toolName: "pinchy_generate_file", agentId });`,
      `});`,
    ].join("\n");
    expect(extractCoveredTools(source)).toEqual(["pinchy_generate_file"]);
  });

  it("ignores a bare toolName literal that is not a pollAuditForTool argument", () => {
    const source = `test("a", async () => {\n  await post("/api/audit", { toolName: "pinchy_read" });\n});`;
    expect(extractCoveredTools(source)).toEqual([]);
  });
});
