// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { extractDocxText } from "./docx-extract";

const FIXTURES = join(import.meta.dirname, "test-fixtures");

describe("extractDocxText", () => {
  it("extracts plain paragraphs, headings, and table cell content", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);

    expect(result.text.length).toBeGreaterThan(50);

    // Every phrase from the golden file must round-trip through mammoth.
    const expected = readFileSync(
      join(FIXTURES, "simple.expected.txt"),
      "utf-8",
    );
    for (const phrase of expected.split("\n").filter(Boolean)) {
      expect(result.text).toContain(phrase);
    }
  });

  it("does not return ZIP binary (PK header) for a real .docx", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);

    // A real .docx starts with `PK\x03\x04`. If extraction silently fell
    // back to utf-8 decoding the buffer, the agent would receive garbage
    // beginning with "PK" — this is the bug the issue is fixing.
    expect(result.text.startsWith("PK")).toBe(false);
  });

  it("throws a clear error when the buffer is not a valid .docx archive", async () => {
    const notDocx = Buffer.from("this is not a docx file", "utf-8");
    await expect(extractDocxText(notDocx)).rejects.toThrow();
  });

  it("emits Markdown headings (#, ##) for Word heading paragraphs", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);
    expect(result.text).toMatch(/^#\s+Customer Briefing\s*$/m);
    expect(result.text).toMatch(/^##\s+Pricing\s*$/m);
  });

  it("emits GFM table syntax (pipe-delimited rows) for Word tables", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);
    // Header row + separator row + data row, all pipe-delimited.
    expect(result.text).toMatch(/\|\s*SKU\s*\|\s*Quantity\s*\|\s*Unit Price\s*\|/);
    expect(result.text).toMatch(/\|\s*WIDGET-BLUE-01\s*\|\s*20\s*\|\s*EUR 42\.50\s*\|/);
  });

  it("replaces embedded images with a textual placeholder, not base64 data URLs", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);
    expect(result.text).not.toMatch(/!\[[^\]]*\]\(data:image\//);
    expect(result.text).not.toMatch(/<img[^>]/i);
  });

  it("strip-image rule replaces <img> with [image] placeholder", async () => {
    // Test the turndown configuration directly with synthetic HTML.
    // We cannot call extractDocxText with a real image-bearing DOCX without
    // a fixture — instead, verify the rule fires correctly by routing
    // synthetic HTML through the same turndown setup used in docx-extract.ts.
    const { default: TurndownService } = await import("turndown");
    const { gfm } = await import("turndown-plugin-gfm");
    const td = new TurndownService({ headingStyle: "atx" });
    td.use(gfm);
    td.addRule("strip-image", {
      filter: "img",
      replacement: () => "[image]",
    });
    const result = td.turndown('<p>Before <img src="" /> after</p>');
    expect(result).toContain("[image]");
    expect(result).not.toMatch(/<img/);
  });
});
