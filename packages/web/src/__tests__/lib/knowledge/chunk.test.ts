import { describe, it, expect } from "vitest";
import { chunkPages } from "@/lib/knowledge/chunk";

/** Builds `count` fixed-width lines (9 chars each) so char-length math in
 * these tests is deterministic: `L<index>` padded with dots to 9 chars. */
function makeLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `L${i}`.padEnd(9, "."));
}

describe("chunkPages", () => {
  it("splits a long single page into multiple chunks, each within targetTokens (chars = tokens * 4)", () => {
    const lines = makeLines(30);
    const page = { page: 1, text: lines.join("\n") };
    const targetTokens = 20; // targetChars = 80
    const targetChars = targetTokens * 4;

    const chunks = chunkPages([page], { targetTokens, overlapRatio: 0.15 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(targetChars);
      expect(chunk.page).toBe(1);
    }
  });

  it("overlaps consecutive chunks of the same page by ~overlapRatio (tail of chunk N reappears at head of chunk N+1)", () => {
    const lines = makeLines(30);
    const page = { page: 1, text: lines.join("\n") };

    const chunks = chunkPages([page], { targetTokens: 20, overlapRatio: 0.15 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const [first, second] = chunks;

    const firstLines = first.text.split("\n");
    const secondLines = second.text.split("\n");

    // The overlap is realized at line granularity: the trailing K lines of
    // chunk N must reappear, in the same order, as the leading K lines of
    // chunk N+1. Find the largest such K.
    let overlapLineCount = 0;
    for (let k = Math.min(firstLines.length, secondLines.length); k >= 1; k--) {
      const tail = firstLines.slice(firstLines.length - k);
      const head = secondLines.slice(0, k);
      if (tail.every((line, i) => line === head[i])) {
        overlapLineCount = k;
        break;
      }
    }

    // The overlap should be a non-trivial fraction of the chunk, not the
    // entire chunk and not nothing.
    expect(overlapLineCount).toBeGreaterThan(0);
    expect(overlapLineCount).toBeLessThan(firstLines.length);

    const sharedChars = firstLines
      .slice(firstLines.length - overlapLineCount)
      .reduce((sum, line) => sum + line.length + 1, 0);
    expect(sharedChars).toBeGreaterThan(0);
    expect(sharedChars).toBeLessThan(first.text.length);
  });

  it("round-trips charStart/charEnd against the source page text for every chunk", () => {
    const lines = makeLines(25);
    const page = { page: 1, text: lines.join("\n") };

    const chunks = chunkPages([page], { targetTokens: 15, overlapRatio: 0.2 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const slice = page.text.slice(chunk.charStart, chunk.charEnd);
      expect(slice).toBe(chunk.text);
    }
  });

  it("never mixes two pages' text into one chunk, and carries page numbers correctly", () => {
    const pageOneLines = makeLines(20).map((l) => `P1-${l}`);
    const pageTwoLines = makeLines(20).map((l) => `P2-${l}`);
    const pages = [
      { page: 1, text: pageOneLines.join("\n") },
      { page: 2, text: pageTwoLines.join("\n") },
    ];

    const chunks = chunkPages(pages, { targetTokens: 15, overlapRatio: 0.15 });

    expect(chunks.length).toBeGreaterThan(2);

    for (const chunk of chunks) {
      if (chunk.page === 1) {
        expect(chunk.text).not.toContain("P2-");
      } else if (chunk.page === 2) {
        expect(chunk.text).not.toContain("P1-");
      } else {
        throw new Error(`unexpected page number ${chunk.page}`);
      }
    }

    // Chunks stay grouped by page: once we see page 2, we never see page 1
    // again.
    const pageSequence = chunks.map((c) => c.page);
    const firstPageTwoIndex = pageSequence.indexOf(2);
    expect(firstPageTwoIndex).toBeGreaterThan(-1);
    expect(pageSequence.slice(firstPageTwoIndex)).toEqual(
      pageSequence.slice(firstPageTwoIndex).map(() => 2)
    );
  });

  it("emits a line longer than the target as its own intact chunk (table-row heuristic)", () => {
    const longRow = "x".repeat(150) + "|" + "y".repeat(150); // 301 chars, no newline
    const page = { page: 1, text: longRow };

    const chunks = chunkPages([page], { targetTokens: 10, overlapRatio: 0.15 }); // targetChars = 40

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(longRow);
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[0].charEnd).toBe(longRow.length);
    expect(chunks[0].page).toBe(1);
  });

  it("produces no chunks for an empty or whitespace-only page", () => {
    const pages = [
      { page: 1, text: "" },
      { page: 2, text: "   \n\t  \n  " },
    ];

    const chunks = chunkPages(pages);

    expect(chunks).toEqual([]);
  });

  it("uses default targetTokens (512) and overlapRatio (0.15) when no options are given", () => {
    const lines = makeLines(5);
    const page = { page: 1, text: lines.join("\n") };

    const chunks = chunkPages([page]);

    // 5 short lines are far under 512 tokens (~2048 chars), so this must
    // collapse into a single chunk covering the whole page.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(page.text);
  });
});
