/**
 * Layout-aware page chunker for the knowledge base ingest pipeline.
 *
 * Splits each extracted PDF page into ~512-token chunks with ~15% overlap,
 * approximating token count via a char heuristic (~4 chars/token) rather
 * than pulling in a real tokenizer dependency. Chunks never cross a page
 * boundary (each carries exactly one `page`, so citations stay
 * page-accurate) and never split mid-line, so a table row is never cut in
 * half — a line that alone exceeds the target is emitted as its own
 * (oversized) chunk instead of being hard-cut.
 */

export interface ChunkPageInput {
  page: number;
  text: string;
}

export interface Chunk {
  text: string;
  page: number;
  /** Offset into `pages[i].text` where this chunk starts (inclusive). */
  charStart: number;
  /** Offset into `pages[i].text` where this chunk ends (exclusive). */
  charEnd: number;
}

export interface ChunkOptions {
  /** Approximate target chunk size in tokens. Defaults to 512. */
  targetTokens?: number;
  /** Approximate overlap between consecutive chunks, as a fraction of the target size. Defaults to 0.15. */
  overlapRatio?: number;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_TARGET_TOKENS = 512;
const DEFAULT_OVERLAP_RATIO = 0.15;

interface Line {
  start: number;
  end: number;
}

/** Splits `text` into lines, tracking each line's [start, end) offsets (excluding the trailing "\n"). */
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      lines.push({ start, end: i });
      start = i + 1;
    }
  }
  lines.push({ start, end: text.length });
  return lines;
}

function chunkSinglePage(page: ChunkPageInput, targetChars: number, overlapChars: number): Chunk[] {
  if (!page.text.trim()) return [];

  const lines = splitLines(page.text);
  const chunks: Chunk[] = [];

  let startLine = 0;
  while (startLine < lines.length) {
    // Greedily accumulate whole lines until adding the next one would
    // exceed the target. A single line that alone exceeds the target is
    // still emitted intact (never hard-cut mid-line).
    let endLine = startLine;
    let length = lines[startLine].end - lines[startLine].start;
    while (endLine + 1 < lines.length) {
      const nextLen = lines[endLine + 1].end - lines[endLine + 1].start;
      if (length + 1 + nextLen > targetChars) break;
      endLine++;
      length += 1 + nextLen;
    }

    const charStart = lines[startLine].start;
    const charEnd = lines[endLine].end;
    const text = page.text.slice(charStart, charEnd);
    if (text.trim().length > 0) {
      chunks.push({ text, page: page.page, charStart, charEnd });
    }

    if (endLine === lines.length - 1) break;

    // Realize the overlap by walking backward from the chunk's last line,
    // accumulating line lengths until we've covered ~overlapChars. The
    // next chunk starts there, so its head repeats the previous chunk's
    // tail. Guaranteed forward progress: the walk never passes startLine.
    let backLine = endLine;
    let backLength = 0;
    while (backLine > startLine && backLength < overlapChars) {
      backLength += lines[backLine].end - lines[backLine].start + 1;
      backLine--;
    }
    startLine = Math.max(backLine + 1, startLine + 1);
  }

  return chunks;
}

export function chunkPages(pages: ChunkPageInput[], opts: ChunkOptions = {}): Chunk[] {
  const targetTokens = opts.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlapRatio = opts.overlapRatio ?? DEFAULT_OVERLAP_RATIO;
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const overlapChars = Math.round(targetChars * overlapRatio);

  const chunks: Chunk[] = [];
  for (const page of pages) {
    chunks.push(...chunkSinglePage(page, targetChars, overlapChars));
  }
  return chunks;
}
