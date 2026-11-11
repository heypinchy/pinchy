/**
 * The ingest never holds a knowledge-base source whole in the server process.
 *
 * Every source is read through a verified descriptor (verified-source.ts). The
 * first version of that read took the file whole (`FileHandle.readFile`) and
 * kept the buffer alive across every await after it — through an Office
 * file's conversion and through the embedding — so a 190 MB deck pinned
 * 190+ MB of the web process for as long as it took, on top of the embedding
 * model. And a batch mate was read whole for its turn in the converter.
 *
 * What the server may do instead is stream: hash the descriptor, and copy it
 * to a private file on the staging volume, one chunk at a time. Readers are
 * handed that copy's path and nothing else — the path #1243's child-process
 * readers take, so they never open a path on the share either.
 *
 * Measured at the seam where whole-file reads happen, not by heap size (which
 * GC timing makes useless as a test): no `readFile` of any kind, and no
 * descriptor read larger than one chunk. Its own file because it replaces
 * `node:fs/promises` with a recording pass-through.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** Every path `fs/promises.readFile` was called with. A pass-through. */
const wholeFileReads = vi.hoisted(() => [] as string[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = ((...args: Parameters<typeof actual.readFile>) => {
    wholeFileReads.push(String(args[0]));
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  const wrapped = { ...actual, readFile };
  return { ...wrapped, default: wrapped };
});

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { makeKbSourceRoot } from "@/test-helpers/kb-source-root";
import { join, sep } from "node:path";

import { ingestDirectory, type IngestDeps } from "@/lib/knowledge/ingest";
import type { ConversionOutcome, OfficeSource } from "@/lib/knowledge/office-convert";
import { SOURCE_CHUNK_BYTES } from "@/lib/knowledge/office-artifacts";

const ORG_ID = "org-kb-ingest-memory-test";

let tmpRoot: string;
let stagingDir: string;

beforeEach(() => {
  tmpRoot = makeKbSourceRoot("pinchy-kb-ingest-memory-");
  stagingDir = mkdtempSync(join(tmpdir(), "pinchy-kb-ingest-memory-staging-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(stagingDir, { recursive: true, force: true });
});

/** A source larger than several chunks, distinct per name. */
function writeSource(name: string): { path: string; bytes: string } {
  const bytes = `${name}:`.padEnd(3 * SOURCE_CHUNK_BYTES + 17, name.slice(0, 1));
  const path = join(tmpRoot, name);
  writeFileSync(path, bytes);
  return { path, bytes };
}

const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

/** The largest read any open descriptor was asked for, and how often one was read whole. */
async function spyOnDescriptorReads() {
  const probe = await open(__filename, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();

  const readWhole = vi.spyOn(prototype, "readFile");
  const read = vi.spyOn(prototype, "read");
  const largestRead = () =>
    Math.max(
      0,
      ...read.mock.calls.map((args: unknown[]) => {
        const [first, , length] = args as [unknown, unknown, number | undefined];
        if (ArrayBuffer.isView(first)) return length ?? first.byteLength;
        if (first && typeof first === "object") {
          const options = first as { buffer?: ArrayBufferView; length?: number };
          return options.length ?? options.buffer?.byteLength ?? 16_384;
        }
        return 16_384; // `read()` with no buffer allocates Node's default.
      })
    );
  return { readWhole, largestRead };
}

it("streams every source through the server one chunk at a time, and hands readers only private copies", async () => {
  const pdf = writeSource("report.pdf");
  const sheet = writeSource("prices.xlsx");
  const deck = writeSource("board.pptx");
  const mate = writeSource("handbook.docx");

  // What each reader was handed, and what that path held while it read.
  const handed: Array<{ path: string; content: string }> = [];
  const look = (path: string) => handed.push({ path, content: readFileSync(path, "utf8") });
  const converted: OfficeSource[] = [];
  const deps: IngestDeps = {
    embed: async (texts) => texts.map(() => Array(768).fill(0.03)),
    extractPdf: async (path) => {
      if (!path.startsWith("/artifacts/")) look(path);
      return [{ page: 1, text: "Every delivery is checked against the order before storage." }];
    },
    extractXlsx: async (path) => {
      look(path);
      return {
        chunks: [{ text: "Supplier: Nordwind GmbH", sheet: "Prices", startRow: 1, endRow: 1 }],
        sheets: ["Prices"],
        hiddenSheets: [],
        hiddenRows: 0,
      };
    },
    readEmail: async () => {
      throw new Error("this run holds no mail");
    },
    convertScan: async () => {
      throw new Error("this run holds no scan");
    },
    convertOffice: async (sources): Promise<ConversionOutcome[]> =>
      sources.map((source) => {
        look(source.absPath);
        converted.push(source);
        return {
          sourcePath: source.absPath,
          status: "converted",
          artifactPath: `/artifacts/${source.contentHash}.pdf`,
        };
      }),
    ocrModel: null,
    stagingDir,
  };

  const { readWhole, largestRead } = await spyOnDescriptorReads();
  wholeFileReads.length = 0;

  const result = await ingestDirectory(ORG_ID, tmpRoot, deps);
  expect(result.indexed).toBe(4);

  // Never whole: not through a path, not through a descriptor, and no
  // descriptor read bigger than the chunk the copy and the hash stream in.
  expect(wholeFileReads).toEqual([]);
  expect(readWhole).not.toHaveBeenCalled();
  expect(largestRead()).toBeLessThanOrEqual(SOURCE_CHUNK_BYTES);

  // Every reader — PDF, workbook, converter, batch mate included — was handed
  // a private copy on the staging volume holding exactly the source's bytes,
  // never a path on the share.
  const byContent = new Map(handed.map((entry) => [entry.content, entry.path]));
  for (const source of [pdf, sheet, deck, mate]) {
    const path = byContent.get(source.bytes);
    expect(path, source.path).toBeDefined();
    expect(path!.startsWith(stagingDir + sep)).toBe(true);
  }
  expect(handed.every((entry) => !entry.path.startsWith(tmpRoot + sep))).toBe(true);

  // The converter got each copy's hash — the hash of exactly the bytes copied.
  expect(converted.map((source) => source.contentHash).sort()).toEqual(
    [sha256(deck.bytes), sha256(mate.bytes)].sort()
  );

  // And no copy outlives the run.
  expect(handed.filter((entry) => existsSync(entry.path))).toEqual([]);
});
