/**
 * Real-DB tests for findCitedPassage (#1268): of the indexed passages on the
 * cited page, which one did the answer draw on?
 *
 * Embeddings are hand-chosen one-hot vectors (see retrieve.integration.test.ts
 * for the geometry): the claim embeds onto one axis, and the chunk on the same
 * axis is the nearest one. The embedder is injected, so no model is loaded.
 */
import { describe, expect, it, vi } from "vitest";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";
import { EMBEDDING_DIMENSIONS } from "@/lib/knowledge/constants";
import { findCitedPassage } from "@/lib/knowledge/cited-passage";
import type { ChunkLocator } from "@/lib/knowledge/locator";

const ORG_ID = "org-kb-cited-passage-test";
const PATH = "/data/quality/Wartung.pdf";

function oneHot(axis: number): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[axis] = 1;
  return v;
}

async function seedDocument(sourcePath: string, orgId = ORG_ID): Promise<string> {
  const [doc] = await db
    .insert(kbDocuments)
    .values({ orgId, contentHash: `hash-${sourcePath}-${orgId}`, sourcePath, status: "active" })
    .returning();
  return doc.id;
}

async function seedChunk(
  documentId: string,
  text: string,
  locator: ChunkLocator | null,
  embedding: number[] | null,
  { sourcePath = PATH, orgId = ORG_ID } = {}
) {
  await db.insert(kbChunks).values({
    documentId,
    orgId,
    sourcePath,
    chunkText: text,
    locator,
    embedding,
  });
}

const embedTo = (axis: number) => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => oneHot(axis))),
});

describe("findCitedPassage", () => {
  it("returns the page's only passage without embedding the claim", async () => {
    const doc = await seedDocument(PATH);
    await seedChunk(doc, "Reaktionszeit vier Stunden", { kind: "page", page: 4 }, oneHot(1));
    await seedChunk(doc, "Andere Seite", { kind: "page", page: 5 }, oneHot(2));
    const deps = embedTo(9);

    const passage = await findCitedPassage(ORG_ID, [PATH], 4, "four hours", deps);

    expect(passage).toEqual({ text: "Reaktionszeit vier Stunden" });
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it("picks the passage on the page nearest to the claim", async () => {
    const doc = await seedDocument(PATH);
    await seedChunk(doc, "Abschnitt Reaktionszeiten", { kind: "page", page: 4 }, oneHot(1));
    await seedChunk(doc, "Abschnitt Vergütung", { kind: "page", page: 4 }, oneHot(2));
    // The nearest chunk overall is on another page: the page narrows first.
    await seedChunk(doc, "Vergütung, Seite 9", { kind: "page", page: 9 }, oneHot(3));
    const deps = embedTo(2);

    const passage = await findCitedPassage(ORG_ID, [PATH], 4, "The fee is 1,200 €", deps);

    expect(passage).toEqual({ text: "Abschnitt Vergütung" });
    expect(deps.embed).toHaveBeenCalledWith(["The fee is 1,200 €"]);
  });

  it("returns no passage when the page holds several and there is no claim", async () => {
    // Choosing one anyway would highlight a passage the answer may not have read.
    const doc = await seedDocument(PATH);
    await seedChunk(doc, "Erster Abschnitt", { kind: "page", page: 4 }, oneHot(1));
    await seedChunk(doc, "Zweiter Abschnitt", { kind: "page", page: 4 }, oneHot(2));
    const deps = embedTo(1);

    expect(await findCitedPassage(ORG_ID, [PATH], 4, undefined, deps)).toBeNull();
    expect(await findCitedPassage(ORG_ID, [PATH], 4, "a claim", null)).toBeNull();
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it("treats identical passages of two paths to one file as one", async () => {
    // A grant can reach one file under two paths (a symlinked folder); both
    // are indexed, and they hold the same text.
    const alias = "/data/alias/Wartung.pdf";
    const a = await seedDocument(PATH);
    const b = await seedDocument(alias);
    await seedChunk(a, "Gleicher Text", { kind: "page", page: 4 }, oneHot(1));
    await seedChunk(b, "Gleicher Text", { kind: "page", page: 4 }, oneHot(1), {
      sourcePath: alias,
    });
    const deps = embedTo(5);

    expect(await findCitedPassage(ORG_ID, [PATH, alias], 4, undefined, deps)).toEqual({
      text: "Gleicher Text",
    });
  });

  it("returns no passage for a page the index holds nothing for", async () => {
    const doc = await seedDocument(PATH);
    await seedChunk(doc, "Seite eins", { kind: "page", page: 1 }, oneHot(1));
    await seedChunk(doc, "Kein Seitenanker", null, oneHot(1));

    expect(await findCitedPassage(ORG_ID, [PATH], 2, "claim", embedTo(1))).toBeNull();
  });

  it("never reads another path's or another org's passages", async () => {
    const other = await seedDocument("/data/secret/Wartung.pdf");
    await seedChunk(other, "Geheim", { kind: "page", page: 4 }, oneHot(1), {
      sourcePath: "/data/secret/Wartung.pdf",
    });
    const foreign = await seedDocument(PATH, "org-elsewhere");
    await seedChunk(foreign, "Fremd", { kind: "page", page: 4 }, oneHot(1), {
      orgId: "org-elsewhere",
    });

    expect(await findCitedPassage(ORG_ID, [PATH], 4, "claim", embedTo(1))).toBeNull();
  });

  it("ignores a chunk with no embedding when ranking", async () => {
    const doc = await seedDocument(PATH);
    await seedChunk(doc, "Ohne Vektor", { kind: "page", page: 4 }, null);
    await seedChunk(doc, "Mit Vektor", { kind: "page", page: 4 }, oneHot(1));

    expect(await findCitedPassage(ORG_ID, [PATH], 4, "claim", embedTo(7))).toEqual({
      text: "Mit Vektor",
    });
  });
});
