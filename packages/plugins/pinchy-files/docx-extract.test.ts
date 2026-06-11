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

  it("replaces embedded images with [image] placeholder via the full pipeline", async () => {
    const buffer = readFileSync(join(FIXTURES, "with-image.docx"));
    const result = await extractDocxText(buffer);
    expect(result.text).toContain("[image]");
    expect(result.text).not.toMatch(/!\[[^\]]*\]\(data:image\//);
    expect(result.text).not.toMatch(/<img[^>]/i);
  });

  // Issue #424: a 50 MB compressed DOCX may decompress to multiple GB (zip
  // bomb). The declared-size guard must reject it BEFORE mammoth inflates.
  it("rejects a zip bomb before inflating it", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    await expect(
      extractDocxText(buffer, { maxDecompressedBytes: 10 }),
    ).rejects.toThrow(/decompressed size .* exceeds/i);
  });

  it("caps the extracted text length as a second defense layer", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    await expect(extractDocxText(buffer, { maxTextBytes: 10 })).rejects.toThrow(
      /extracted text .* exceeds/i,
    );
  });

  it("extracts normally with default limits (regression guard)", async () => {
    const buffer = readFileSync(join(FIXTURES, "simple.docx"));
    const result = await extractDocxText(buffer);
    expect(result.text.length).toBeGreaterThan(50);
  });
});
