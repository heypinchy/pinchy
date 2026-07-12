/**
 * Knowledge-base ingest pipeline (server-side): discover -> extract -> chunk
 * -> embed -> upsert.
 *
 * Idempotent on (orgId, sourcePath, contentHash):
 *   - unchanged file (same content hash) with chunks already present -> skip.
 *   - unchanged file whose document row has zero chunks (partial/legacy
 *     state — see the doc comment on the zero-chunk branch below) -> rebuild
 *     chunks in place.
 *   - changed file (different content hash) -> replace: delete the old
 *     document row (cascades to its chunks) and re-ingest.
 *   - a previously-indexed file that's gone from disk -> delete its document
 *     row (cascades to its chunks).
 *
 * The embedder and PDF extractor are dependency-injected: production wires
 * `embedTexts` (./embeddings.ts) and a pdfjs-based extractor
 * (./pdf-extract.ts); tests inject deterministic fakes so the integration
 * suite stays hermetic (real Postgres, no Ollama, no real PDF parsing).
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import { and, count, eq } from "drizzle-orm";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";

import {
  DEFAULT_ALLOWED_EXTENSIONS,
  isAllowedExtension,
  isDenylistedDirName,
  isDenylistedFileName,
  isHiddenSegment,
} from "./exclude-globs";
import { chunkPages } from "./chunk";
import { detectLang } from "./lid";

export interface IngestPage {
  page: number;
  text: string;
}

export interface IngestDeps {
  /** Batch-embeds chunk texts into dense vectors (bge-m3, 1024-dim). Prod: `(t) => embedTexts(t, embedCfg)`. */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Extracts per-page text from a PDF at an absolute path. Prod: pdfjs-based (./pdf-extract.ts). */
  extractPdf: (absPath: string) => Promise<IngestPage[]>;
}

export interface IngestOptions {
  /** Overrides the default extension allowlist (`[".pdf"]` for the MVP). */
  allowedExtensions?: readonly string[];
}

export interface IngestResult {
  /** Documents newly indexed, replaced due to a content change, or recovered from a zero-chunk state. */
  indexed: number;
  /** Documents left untouched: unchanged content hash, chunks already present. */
  skipped: number;
  /** Documents deleted because their source file is no longer on disk. */
  removed: number;
}

/** Recursively lists ingest-eligible files under `rootDir`, applying the allowlist + skip-hidden + A/B denylist (exclude-globs.ts). */
async function discoverFiles(
  rootDir: string,
  allowedExtensions: readonly string[]
): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (isHiddenSegment(entry.name)) continue;
    const absPath = join(rootDir, entry.name);

    if (entry.isDirectory()) {
      if (isDenylistedDirName(entry.name)) continue;
      files.push(...(await discoverFiles(absPath, allowedExtensions)));
    } else if (entry.isFile()) {
      if (isDenylistedFileName(entry.name)) continue;
      if (!isAllowedExtension(entry.name, allowedExtensions)) continue;
      files.push(absPath);
    }
  }

  return files;
}

/** Chunks `pages`, embeds every chunk, and inserts the resulting kb_chunks rows for `documentId`. No-op if chunking yields nothing (e.g. an all-whitespace PDF). */
async function writeChunks(
  documentId: string,
  orgId: string,
  sourcePath: string,
  pages: IngestPage[],
  deps: IngestDeps
): Promise<void> {
  const chunks = chunkPages(pages);
  if (chunks.length === 0) return;

  const vectors = await deps.embed(chunks.map((chunk) => chunk.text));

  await db.insert(kbChunks).values(
    chunks.map((chunk, i) => ({
      documentId,
      orgId,
      sourcePath,
      chunkText: chunk.text,
      page: chunk.page,
      lang: detectLang(chunk.text),
      embedding: vectors[i],
    }))
  );
}

export async function ingestDirectory(
  orgId: string,
  rootDir: string,
  deps: IngestDeps,
  opts: IngestOptions = {}
): Promise<IngestResult> {
  const allowedExtensions = opts.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS;
  const discovered = await discoverFiles(rootDir, allowedExtensions);

  let indexed = 0;
  let skipped = 0;

  for (const absPath of discovered) {
    const buffer = await readFile(absPath);
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const fileStat = await stat(absPath);

    const [existing] = await db
      .select()
      .from(kbDocuments)
      .where(and(eq(kbDocuments.orgId, orgId), eq(kbDocuments.sourcePath, absPath)))
      .limit(1);

    if (existing && existing.contentHash === contentHash) {
      const [{ value: chunkCount }] = await db
        .select({ value: count() })
        .from(kbChunks)
        .where(eq(kbChunks.documentId, existing.id));

      if (chunkCount > 0) {
        skipped++;
        continue;
      }

      // Robustness case: a document row survives with zero chunks (e.g. a
      // prior ingest crashed after the document insert but before chunk
      // writes, or an operator hand-deleted kb_chunks rows). The content
      // hash still matches the file on disk, so a naive "hash matches ->
      // skip" would leave this document permanently unsearchable while
      // silently reporting success. We recover instead: rebuild chunks for
      // the existing document (same id, no duplicate row).
      const pages = await deps.extractPdf(absPath);
      await writeChunks(existing.id, orgId, absPath, pages, deps);
      indexed++;
      continue;
    }

    if (existing) {
      // Content changed since the last ingest: replace wholesale. Deleting
      // the document row cascades to its (now stale) chunks via the
      // kb_chunks.document_id FK.
      await db.delete(kbDocuments).where(eq(kbDocuments.id, existing.id));
    }

    const pages = await deps.extractPdf(absPath);
    const wholeDocText = pages.map((p) => p.text).join("\n");

    const [doc] = await db
      .insert(kbDocuments)
      .values({
        orgId,
        contentHash,
        sourcePath: absPath,
        pageCount: pages.length,
        mtime: fileStat.mtime,
        lang: detectLang(wholeDocText),
      })
      .returning();

    await writeChunks(doc.id, orgId, absPath, pages, deps);
    indexed++;
  }

  // Removal pass: any previously-indexed document under this root whose
  // source file is no longer among the discovered files. Scoped to rootDir
  // (with a path-separator boundary, so "/data/foo" never matches
  // "/data/foobar/x.pdf") so ingesting one directory never touches documents
  // indexed from a different root for the same org.
  const discoveredSet = new Set(discovered);
  const rootPrefix = rootDir.endsWith(sep) ? rootDir : rootDir + sep;
  const existingForOrg = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, orgId));

  let removed = 0;
  for (const doc of existingForOrg) {
    if (!doc.sourcePath.startsWith(rootPrefix)) continue;
    if (discoveredSet.has(doc.sourcePath)) continue;
    await db.delete(kbDocuments).where(eq(kbDocuments.id, doc.id));
    removed++;
  }

  return { indexed, skipped, removed };
}
