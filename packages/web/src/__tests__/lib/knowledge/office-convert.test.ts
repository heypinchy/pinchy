/**
 * convertOfficeFiles: LibreOffice batch conversion + the verification chain.
 *
 * The converter subprocess is dependency-injected, for the same reason
 * ingest.ts injects its embedder: LibreOffice is a 422 MB image layer that
 * exists only in the container, and the behaviour worth testing is not "does
 * soffice work" but what this module concludes from what soffice did. The
 * fake's behaviour is not invented — it reproduces what a real
 * `libreoffice-writer` in the runtime image actually does, verified by probing
 * it directly:
 *
 *   - the output PDF is named after the file we hand it (so index-named
 *     staging symlinks give index-named outputs),
 *   - an input it cannot load prints "Error: source file could not be loaded"
 *     on stderr, exits **0**, and simply writes no artifact — while every
 *     other file in the same batch still converts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  batchTimeoutMs,
  convertOfficeFiles,
  isOfficeFile,
  OFFICE_EXTENSIONS,
  OFFICE_VERIFY_EPSILON,
  type ConverterRun,
  type ConvertOptions,
  type OfficeSource,
  type RunConverter,
} from "@/lib/knowledge/office-convert";
import { OfficeArtifactStore } from "@/lib/knowledge/office-artifacts";

let tmpRoot: string;
let corpusDir: string;
let storeDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-office-test-"));
  corpusDir = join(tmpRoot, "data");
  storeDir = join(tmpRoot, "artifacts");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Writes a corpus file (under the read-only-in-production `/data` stand-in). */
async function corpusFile(relPath: string, body: string): Promise<OfficeSource> {
  const absPath = join(corpusDir, relPath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, body);
  return { absPath };
}

interface FakeConverterOptions {
  /**
   * Source basename -> the text its converted PDF carries. A source mapped to
   * `null` is one LibreOffice cannot load: no artifact, no non-zero exit.
   */
  outputs: Record<string, string | null>;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** Throws instead of running — how a missing `soffice` binary surfaces. */
  spawnError?: Error;
}

interface FakeConverter {
  run: RunConverter;
  calls: ConverterRun[];
}

/**
 * A converter that resolves each staged input back to its real source (which
 * also proves the staging symlink points where we think it does) and writes
 * `<staged basename>.pdf` for the sources it can load.
 */
function fakeConverter(options: FakeConverterOptions): FakeConverter {
  const calls: ConverterRun[] = [];
  const run: RunConverter = async (call) => {
    calls.push(call);
    if (options.spawnError) throw options.spawnError;

    let stderr = "";
    for (const staged of call.inputs) {
      const source = basename(await realpath(staged));
      const text = options.outputs[source];
      if (text == null) {
        stderr += "Error: source file could not be loaded\n";
        continue;
      }
      const outName = basename(staged, extname(staged)) + ".pdf";
      await writeFile(join(call.outDir, outName), `%PDF-1.4\n${text}\n`);
    }
    return { code: options.exitCode ?? 0, signal: options.signal ?? null, stderr };
  };
  return { run, calls };
}

/** Reads back the stand-in PDF the fake converter wrote and counts its words. */
async function fakeCountPdfWords(absPath: string): Promise<number> {
  const body = await readFile(absPath, "utf8");
  return body.replace("%PDF-1.4", "").trim().split(/\s+/).filter(Boolean).length;
}

/** Everything the module needs except the store, wired to a scripted converter. */
function deps(converter: FakeConverter, extra: Partial<ConvertOptions> = {}): ConvertOptions {
  return {
    store: new OfficeArtifactStore(storeDir),
    runConverter: converter.run,
    countPdfWords: fakeCountPdfWords,
    // Default: no independent extractor for this format (the honest answer for
    // legacy binaries when catdoc is absent). Tests that exercise the tripwire
    // override it.
    countSourceWords: async () => null,
    ...extra,
  };
}

describe("isOfficeFile", () => {
  it("recognises the page-shaped Office formats, modern and legacy", () => {
    expect(OFFICE_EXTENSIONS).toEqual([".doc", ".docx", ".ppt", ".pptx"]);
    for (const ext of OFFICE_EXTENSIONS) {
      expect(isOfficeFile(`/data/report${ext}`)).toBe(true);
      expect(isOfficeFile(`/data/report${ext.toUpperCase()}`)).toBe(true);
    }
  });

  it("does not claim spreadsheets — those take a different path (#937/#940)", () => {
    expect(isOfficeFile("/data/budget.xlsx")).toBe(false);
    expect(isOfficeFile("/data/budget.xls")).toBe(false);
    expect(isOfficeFile("/data/report.pdf")).toBe(false);
  });
});

describe("convertOfficeFiles", () => {
  it("converts every format to a PDF in the artifact store", async () => {
    const sources = [
      await corpusFile("a.doc", "legacy word"),
      await corpusFile("b.docx", "modern word"),
      await corpusFile("c.ppt", "legacy slides"),
      await corpusFile("d.pptx", "modern slides"),
    ];
    const converter = fakeConverter({
      outputs: { "a.doc": "one two", "b.docx": "one two", "c.ppt": "one two", "d.pptx": "one two" },
    });

    const outcomes = await convertOfficeFiles(sources, deps(converter));

    expect(outcomes.map((o) => o.status)).toEqual([
      "converted",
      "converted",
      "converted",
      "converted",
    ]);
    // Results come back in input order so a caller can zip them with its queue.
    expect(outcomes.map((o) => o.sourcePath)).toEqual(sources.map((s) => s.absPath));
    for (const outcome of outcomes) {
      expect(outcome.artifactPath!.startsWith(storeDir + "/")).toBe(true);
      expect(await readFile(outcome.artifactPath!, "utf8")).toContain("one two");
    }
  });

  it("uses ONE converter process for the whole batch, not one per file", async () => {
    const sources = await Promise.all(
      Array.from({ length: 6 }, (_, i) => corpusFile(`f${i}.doc`, `body ${i}`))
    );
    const outputs = Object.fromEntries(sources.map((s, i) => [`f${i}.doc`, `body ${i}`]));
    const converter = fakeConverter({ outputs });

    await convertOfficeFiles(sources, deps(converter));

    // Process startup dominates: 17 real corpus files took 14.2 s in one
    // process vs 25.6 s one-per-file.
    expect(converter.calls).toHaveLength(1);
    expect(converter.calls[0].inputs).toHaveLength(6);
  });

  it("splits into bounded batches so one OOM kill cannot cost the whole corpus", async () => {
    const sources = await Promise.all(
      Array.from({ length: 5 }, (_, i) => corpusFile(`f${i}.doc`, `body ${i}`))
    );
    const outputs = Object.fromEntries(sources.map((s, i) => [`f${i}.doc`, `body ${i}`]));
    const converter = fakeConverter({ outputs });

    const outcomes = await convertOfficeFiles(sources, deps(converter, { batchSize: 2 }));

    expect(converter.calls.map((c) => c.inputs.length)).toEqual([2, 2, 1]);
    expect(outcomes.every((o) => o.status === "converted")).toBe(true);
  });

  it("keeps documents apart when two directories hold the same file name", async () => {
    // A real corpus is full of `Rechnung.doc`. LibreOffice derives the output
    // name from the input's basename, so unstaged inputs would overwrite each
    // other in the shared outdir and one document would be served the other's
    // content — a citation pointing at the wrong text.
    const sources = [
      await corpusFile("sub-a/Rechnung.doc", "invoice A"),
      await corpusFile("sub-b/Rechnung.doc", "invoice B"),
    ];
    const converter: FakeConverter = {
      calls: [],
      run: async (call) => {
        converter.calls.push(call);
        for (const staged of call.inputs) {
          const body = await readFile(await realpath(staged), "utf8");
          await writeFile(
            join(call.outDir, basename(staged, extname(staged)) + ".pdf"),
            `%PDF-1.4\n${body}\n`
          );
        }
        return { code: 0, signal: null, stderr: "" };
      },
    };

    const outcomes = await convertOfficeFiles(sources, deps(converter));

    expect(await readFile(outcomes[0].artifactPath!, "utf8")).toContain("invoice A");
    expect(await readFile(outcomes[1].artifactPath!, "utf8")).toContain("invoice B");
  });

  describe("failure modes", () => {
    it("reports exit 0 with no artifact as a DOCUMENT-level failure", async () => {
      // The exit code lies: LibreOffice returns 0 for an input it could not
      // load and only says so on stderr. A pipeline that trusts the return
      // value books the document as converted and indexes nothing.
      const sources = [
        await corpusFile("good.doc", "fine"),
        await corpusFile("broken.docx", "truncated zip"),
      ];
      const converter = fakeConverter({ outputs: { "good.doc": "one two", "broken.docx": null } });

      const outcomes = await convertOfficeFiles(sources, deps(converter));

      expect(outcomes[0].status).toBe("converted");
      expect(outcomes[1].status).toBe("failed");
      expect(outcomes[1].artifactPath).toBeUndefined();
      expect(outcomes[1].reason).toMatch(/could not be loaded|no artifact/i);
    });

    it("does NOT mark documents unreadable when the process was OOM-killed (exit 137)", async () => {
      // Without this split one memory squeeze brands perfectly good documents
      // as permanently unreadable and nothing ever retries them.
      const sources = [await corpusFile("a.doc", "x"), await corpusFile("b.doc", "y")];
      const converter = fakeConverter({ outputs: {}, exitCode: 137 });

      const outcomes = await convertOfficeFiles(sources, deps(converter));

      expect(outcomes.map((o) => o.status)).toEqual(["infrastructure", "infrastructure"]);
      expect(outcomes[0].reason).toMatch(/memory/i);
    });

    it("treats a direct SIGKILL the same as exit 137", async () => {
      // 137 is what a shell (or `docker run`) reports; a direct spawn sees the
      // signal instead, with a null exit code. Same event, same conclusion.
      const sources = [await corpusFile("a.doc", "x")];
      const converter = fakeConverter({ outputs: {}, exitCode: null, signal: "SIGKILL" });

      const outcomes = await convertOfficeFiles(sources, deps(converter));

      expect(outcomes[0].status).toBe("infrastructure");
    });

    it("does not blame the document when the converter binary is missing", async () => {
      const sources = [await corpusFile("a.doc", "x")];
      const converter = fakeConverter({
        outputs: {},
        spawnError: Object.assign(new Error("spawn soffice ENOENT"), { code: "ENOENT" }),
      });

      const outcomes = await convertOfficeFiles(sources, deps(converter));

      expect(outcomes[0].status).toBe("infrastructure");
    });

    it("still converts the rest of a batch when one file cannot be loaded", async () => {
      const sources = [
        await corpusFile("a.doc", "alpha"),
        await corpusFile("broken.doc", "bravo"),
        await corpusFile("c.doc", "charlie"),
      ];
      const converter = fakeConverter({
        outputs: { "a.doc": "one two", "broken.doc": null, "c.doc": "three four" },
      });

      const outcomes = await convertOfficeFiles(sources, deps(converter));

      expect(outcomes.map((o) => o.status)).toEqual(["converted", "failed", "converted"]);
      expect(converter.calls).toHaveLength(1);
    });

    it("reports an empty artifact as a document-level failure", async () => {
      const sources = [await corpusFile("a.doc", "x")];
      const converter: FakeConverter = {
        calls: [],
        run: async (call) => {
          converter.calls.push(call);
          await writeFile(join(call.outDir, "0.pdf"), "");
          return { code: 0, signal: null, stderr: "" };
        },
      };

      const outcomes = await convertOfficeFiles(sources, deps(converter));

      expect(outcomes[0].status).toBe("failed");
    });
  });

  describe("verification chain", () => {
    it("passes a conversion whose PDF carries at least the source's words", async () => {
      const sources = [await corpusFile("a.docx", "x")];
      const converter = fakeConverter({ outputs: { "a.docx": "one two three four five" } });

      const outcomes = await convertOfficeFiles(
        sources,
        deps(converter, { countSourceWords: async () => 5 })
      );

      expect(outcomes[0].status).toBe("converted");
      expect(outcomes[0].verification).toEqual({
        status: "ok",
        sourceWords: 5,
        pdfWords: 5,
        epsilon: OFFICE_VERIFY_EPSILON,
      });
    });

    it("passes when the PDF carries MORE words than the oracle saw", async () => {
      // Measured on the real corpus: a .docx came out +25 % because it carries
      // three headers and three footers a raw `word/document.xml` read
      // structurally cannot see. Every deviation was the oracle
      // under-reporting; an equality round-trip would fire constantly.
      const sources = [await corpusFile("a.docx", "x")];
      const converter = fakeConverter({ outputs: { "a.docx": "one two three four five six" } });

      const outcomes = await convertOfficeFiles(
        sources,
        deps(converter, { countSourceWords: async () => 4 })
      );

      expect(outcomes[0].status).toBe("converted");
      expect(outcomes[0].verification!.status).toBe("ok");
    });

    it("fails a conversion that lost content — the clipped-text-box tripwire", async () => {
      // The synthetic fixture the real corpus never provided: a fixed-size text
      // box that overflows, so the rendered PDF silently drops what does not
      // fit. This is the failure the lower bound exists for.
      const sources = [await corpusFile("a.docx", "x")];
      const converter = fakeConverter({ outputs: { "a.docx": "one two three" } });

      const outcomes = await convertOfficeFiles(
        sources,
        deps(converter, { countSourceWords: async () => 100 })
      );

      expect(outcomes[0].status).toBe("failed");
      expect(outcomes[0].verification).toEqual({
        status: "short",
        sourceWords: 100,
        pdfWords: 3,
        epsilon: OFFICE_VERIFY_EPSILON,
      });
      // A conversion that failed verification is never stored: nothing may
      // serve a preview whose text the index does not have.
      expect(outcomes[0].artifactPath).toBeUndefined();
    });

    it("tolerates tokenisation noise up to epsilon", async () => {
      const sources = [
        await corpusFile("a.docx", "alpha"),
        await corpusFile("b.docx", "bravo"),
        await corpusFile("c.docx", "charlie"),
      ];
      const converter = fakeConverter({
        outputs: {
          "a.docx": Array.from({ length: 91 }, (_, i) => `w${i}`).join(" "),
          "b.docx": Array.from({ length: 90 }, (_, i) => `w${i}`).join(" "),
          "c.docx": Array.from({ length: 89 }, (_, i) => `w${i}`).join(" "),
        },
      });

      const outcomes = await convertOfficeFiles(
        sources,
        deps(converter, { countSourceWords: async () => 100 })
      );

      // epsilon = 0.10 -> the bound sits at exactly 90 words.
      expect(outcomes.map((o) => o.status)).toEqual(["converted", "converted", "failed"]);
    });

    it("records `unverified` rather than `ok` when no independent extractor exists", async () => {
      // A `.pptx` has no oracle in the image, and a legacy binary has none
      // without catdoc. Claiming "verified" there would be a lie; the tripwire
      // is a tripwire, not a guarantee.
      const sources = [await corpusFile("a.pptx", "x")];
      const converter = fakeConverter({ outputs: { "a.pptx": "one two" } });

      const outcomes = await convertOfficeFiles(
        sources,
        deps(converter, { countSourceWords: async () => null })
      );

      expect(outcomes[0].status).toBe("converted");
      expect(outcomes[0].verification!.status).toBe("unverified");
      expect(outcomes[0].verification!.sourceWords).toBeNull();
    });

    it("does not fail a document because its oracle broke", async () => {
      const sources = [await corpusFile("a.doc", "x")];
      const converter = fakeConverter({ outputs: { "a.doc": "one two" } });

      const outcomes = await convertOfficeFiles(
        sources,
        deps(converter, {
          countSourceWords: async () => {
            throw new Error("catdoc: segmentation fault");
          },
        })
      );

      expect(outcomes[0].status).toBe("converted");
      expect(outcomes[0].verification!.status).toBe("unverified");
    });

    it("does not fail a source the oracle reads as empty", async () => {
      // An oracle that returns 0 says nothing about the conversion; 0 * (1-ε)
      // is 0, which every PDF clears, but an explicit case documents that a
      // slide deck of images is not a conversion failure.
      const sources = [await corpusFile("a.ppt", "x")];
      const converter = fakeConverter({ outputs: { "a.ppt": "" } });

      const outcomes = await convertOfficeFiles(
        sources,
        deps(converter, { countSourceWords: async () => 0 })
      );

      expect(outcomes[0].status).toBe("converted");
      expect(outcomes[0].verification!.status).toBe("ok");
    });
  });

  describe("artifact reuse", () => {
    it("does not re-run the converter for content already in the store", async () => {
      const source = await corpusFile("a.doc", "unchanged body");
      const converter = fakeConverter({ outputs: { "a.doc": "one two" } });
      const store = new OfficeArtifactStore(storeDir);

      const first = await convertOfficeFiles([source], deps(converter, { store }));
      const second = await convertOfficeFiles([source], deps(converter, { store }));

      expect(converter.calls).toHaveLength(1);
      expect(second[0].status).toBe("converted");
      expect(second[0].artifactPath).toBe(first[0].artifactPath);
      expect(second[0].verification!.status).toBe("cached");
    });

    it("converts once when two paths hold identical content", async () => {
      const sources = [
        await corpusFile("guide.doc", "same bytes"),
        await corpusFile("copies/guide.doc", "same bytes"),
      ];
      const converter = fakeConverter({ outputs: { "guide.doc": "one two" } });

      const outcomes = await convertOfficeFiles(sources, deps(converter));

      expect(converter.calls[0].inputs).toHaveLength(1);
      expect(outcomes[0].artifactPath).toBe(outcomes[1].artifactPath);
      expect(outcomes.every((o) => o.status === "converted")).toBe(true);
    });

    it("re-converts after the format version is bumped", async () => {
      const source = await corpusFile("a.doc", "body");
      const converter = fakeConverter({ outputs: { "a.doc": "one two" } });

      await convertOfficeFiles(
        [source],
        deps(converter, { store: new OfficeArtifactStore(storeDir, { formatVersion: 1 }) })
      );
      await convertOfficeFiles(
        [source],
        deps(converter, { store: new OfficeArtifactStore(storeDir, { formatVersion: 2 }) })
      );

      expect(converter.calls).toHaveLength(2);
    });
  });

  describe("containment", () => {
    it("never writes anything under the corpus directory", async () => {
      // /data is mounted read-only and the docs state that as a product
      // promise. Everything the conversion produces — staged inputs, the
      // LibreOffice profile, the output PDF — must land in the artifact store.
      const sources = [
        await corpusFile("a.doc", "x"),
        await corpusFile("sub/b.docx", "y"),
        await corpusFile("sub/broken.ppt", "z"),
      ];
      const before = await listTree(corpusDir);
      const converter = fakeConverter({
        outputs: { "a.doc": "one two", "b.docx": "one two", "broken.ppt": null },
      });

      await convertOfficeFiles(sources, deps(converter));

      expect(await listTree(corpusDir)).toEqual(before);
      for (const call of converter.calls) {
        expect(call.outDir.startsWith(storeDir + "/")).toBe(true);
        expect(call.profileDir.startsWith(storeDir + "/")).toBe(true);
        for (const staged of call.inputs) expect(staged.startsWith(storeDir + "/")).toBe(true);
      }
    });

    it("leaves no staging directory behind, on success or on failure", async () => {
      const sources = [await corpusFile("a.doc", "x"), await corpusFile("b.doc", "y")];
      const store = new OfficeArtifactStore(storeDir);
      const ok = fakeConverter({ outputs: { "a.doc": "one two", "b.doc": "three four" } });
      await convertOfficeFiles(sources, deps(ok, { store }));

      const boom = fakeConverter({ outputs: {}, spawnError: new Error("spawn soffice ENOENT") });
      await convertOfficeFiles(sources, deps(boom, { store }));

      expect(await listTree(join(storeDir, "staging"))).toEqual([]);
    });

    it("leaves the store untouched when nothing needs converting", async () => {
      const outcomes = await convertOfficeFiles([], deps(fakeConverter({ outputs: {} })));
      expect(outcomes).toEqual([]);
    });
  });

  it("gives the converter a time budget that scales with the batch", async () => {
    // A fixed timeout would kill a legitimately large batch and report the
    // whole thing as infrastructure — turning "many documents" into a
    // permanent, self-inflicted failure.
    const sources = await Promise.all(
      Array.from({ length: 4 }, (_, i) => corpusFile(`f${i}.doc`, `body ${i}`))
    );
    const outputs = Object.fromEntries(sources.map((s, i) => [`f${i}.doc`, `body ${i}`]));
    const converter = fakeConverter({ outputs });

    await convertOfficeFiles(sources, deps(converter, { batchSize: 2 }));

    const [small, large] = [batchTimeoutMs(2), batchTimeoutMs(20)];
    expect(large).toBeGreaterThan(small);
    for (const call of converter.calls) {
      expect(call.timeoutMs).toBe(batchTimeoutMs(call.inputs.length));
    }
  });

  it("reports progress per batch so a long corpus is not silent", async () => {
    const sources = await Promise.all(
      Array.from({ length: 5 }, (_, i) => corpusFile(`f${i}.doc`, `body ${i}`))
    );
    const outputs = Object.fromEntries(sources.map((s, i) => [`f${i}.doc`, `body ${i}`]));
    const onProgress = vi.fn();

    await convertOfficeFiles(
      sources,
      deps(fakeConverter({ outputs }), { batchSize: 2, onProgress })
    );

    expect(onProgress.mock.calls.map(([p]) => p.processed)).toEqual([2, 4, 5]);
    expect(onProgress.mock.calls.every(([p]) => p.total === 5)).toBe(true);
  });
});

/** Recursive, sorted listing of a directory tree — [] if it does not exist. */
async function listTree(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries.map((e) => join(e.parentPath, e.name)).sort();
}
