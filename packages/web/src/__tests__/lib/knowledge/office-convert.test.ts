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
import { constants as fsConstants, existsSync, mkdtempSync, rmSync } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { format } from "node:util";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import mammoth from "mammoth";

import {
  batchTimeoutMs,
  convertOfficeFiles,
  countSourceWordsWithOracle,
  type OracleDeps,
  isOfficeFile,
  MIN_FREE_OUTPUT_BYTES,
  MIN_FREE_OUTPUT_INODES,
  OFFICE_EXTENSIONS,
  OFFICE_VERIFY_EPSILON,
  type ConverterResult,
  type ConverterRun,
  type ConvertOptions,
  type OfficeSource,
  type RunConverter,
} from "@/lib/knowledge/office-convert";
import { OfficeArtifactStore } from "@/lib/knowledge/office-artifacts";
import { MAX_DOCX_MARKUP_BYTES } from "../../../../../plugins/pinchy-files/docx-zip-guard";
import { OfficeFileRejectedError, StagedCopyWriteError } from "@/lib/knowledge/office-formats";
import { countDocxWordsIsolated, stageOfficeSourceIsolated } from "@/lib/knowledge/xlsx-isolated";
import {
  declaredBomb,
  docxWith,
  lyingEntry,
  REL_HYPERLINK,
  REL_IMAGE,
  relationships,
  replaceEntry,
} from "@/test-helpers/office-zip";

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
/** What turns one log line into two, or reorders one on a terminal. */
const BREAKS_A_LINE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

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
      // LibreOffice names the output after the input and the target format,
      // and the target follows the inputs (office-soffice.ts,
      // `convertTargetFor`): a legacy workbook comes out as a workbook.
      const outExt = extname(staged).toLowerCase() === ".xls" ? ".xlsx" : ".pdf";
      const outName = basename(staged, extname(staged)) + outExt;
      await writeFile(join(call.outDir, outName), `%PDF-1.4\n${text}\n`);
    }
    return { code: options.exitCode ?? 0, signal: options.signal ?? null, stderr };
  };
  return { run, calls };
}

/** The error `promise` rejects with; fails the test if it resolves. */
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err as Error
  );

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
    // These fixtures are plain text under Office names, which the real
    // preflight (rightly) refuses: stage a link to the original, as before.
    // The preflight has its own suite (office-preflight.test.ts), and the
    // "preflight" block below turns the real one back on.
    prepareSource: async () => null,
    ...extra,
  };
}

describe("isOfficeFile", () => {
  it("recognises the page-shaped Office formats, modern and legacy", () => {
    // `.docm` is a `.docx` that also carries macros; it converts the same way (#1409).
    expect(OFFICE_EXTENSIONS).toEqual([".doc", ".docx", ".docm", ".ppt", ".pptx"]);
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

    describe("a batch the converter did not survive", () => {
      // A batch is a fixed slice of a sorted queue, so the same documents meet
      // in the same batch every night. Booking a kill against all of them
      // would let one deck that takes LibreOffice down keep its batch-mates
      // from ever being converted — and a document owed a conversion keeps no
      // preview and no searchable text in the meantime.

      /** Converts what it is given, unless `kills(inputs)` says this run dies. */
      function dyingConverter(
        outputs: Record<string, string>,
        kills: (sources: string[]) => Partial<Pick<ConverterResult, "code" | "signal" | "timedOut">>
      ): FakeConverter {
        const converter = fakeConverter({ outputs });
        return {
          calls: converter.calls,
          run: async (call) => {
            const sources = await Promise.all(
              call.inputs.map(async (staged) => basename(await realpath(staged)))
            );
            const death = kills(sources);
            if (Object.keys(death).length === 0) return converter.run(call);
            converter.calls.push(call);
            // Whatever it wrote before it died is half a PDF at best.
            const first = call.inputs[0];
            await writeFile(
              join(call.outDir, basename(first, extname(first)) + ".pdf"),
              "%PDF-1.4\nhalf"
            );
            return { code: null, signal: null, stderr: "", ...death };
          },
        };
      }

      it("converts the rest of a batch one document killed, one document at a time", async () => {
        const sources = [
          await corpusFile("a.doc", "alpha"),
          await corpusFile("bomb.pptx", "takes LibreOffice down"),
          await corpusFile("c.doc", "charlie"),
        ];
        const converter = dyingConverter(
          { "a.doc": "one two", "bomb.pptx": "never", "c.doc": "three four" },
          (inputs) => (inputs.includes("bomb.pptx") ? { code: 137 } : {})
        );

        const outcomes = await convertOfficeFiles(sources, deps(converter));

        expect(outcomes.map((o) => o.status)).toEqual(["converted", "infrastructure", "converted"]);
        expect(outcomes[1].reason).toMatch(/memory/i);
        expect(await readFile(outcomes[0].artifactPath!, "utf8")).toContain("one two");
        expect(await readFile(outcomes[2].artifactPath!, "utf8")).toContain("three four");
        // The batch, then each of its documents once on its own.
        expect(converter.calls.map((c) => c.inputs.length)).toEqual([3, 1, 1, 1]);
      });

      it("gives each document of a batch that ran out of time its own run and its own budget", async () => {
        // Twenty large decks can outlast the batch's budget together while
        // each converts well inside its own.
        const sources = [await corpusFile("a.pptx", "alpha"), await corpusFile("b.pptx", "bravo")];
        const converter = dyingConverter(
          { "a.pptx": "one two", "b.pptx": "three four" },
          (inputs) => (inputs.length > 1 ? { timedOut: true } : {})
        );

        const outcomes = await convertOfficeFiles(sources, deps(converter));

        expect(outcomes.map((o) => o.status)).toEqual(["converted", "converted"]);
        expect(converter.calls.map((c) => c.timeoutMs)).toEqual([
          batchTimeoutMs(2),
          batchTimeoutMs(1),
          batchTimeoutMs(1),
        ]);
      });

      it("runs each document at most once more, and books one that dies alone as infrastructure", async () => {
        // A document that takes LibreOffice down on its own may be one the
        // container is too small for: that is the machine's to fix, so it
        // stays retryable rather than becoming a verdict — but it is retried
        // on the next run, not in a loop now.
        const sources = [
          await corpusFile("a.doc", "x"),
          await corpusFile("b.doc", "y"),
          await corpusFile("c.doc", "z"),
        ];
        const converter = dyingConverter({}, () => ({ signal: "SIGKILL" }));

        const outcomes = await convertOfficeFiles(sources, deps(converter));

        expect(outcomes.map((o) => o.status)).toEqual([
          "infrastructure",
          "infrastructure",
          "infrastructure",
        ]);
        expect(converter.calls.map((c) => c.inputs.length)).toEqual([3, 1, 1, 1]);
      });

      it("never takes a PDF the killed batch left behind", async () => {
        // The batch died while writing `0.pdf`; the document's own run then
        // cannot load it and writes nothing. Half a PDF must not be stored as
        // its conversion.
        const sources = [await corpusFile("a.doc", "x"), await corpusFile("b.doc", "y")];
        const converter = dyingConverter({ "b.doc": "three four" }, (inputs) =>
          inputs.length > 1 ? { code: 137 } : {}
        );

        const outcomes = await convertOfficeFiles(sources, deps(converter));

        expect(outcomes.map((o) => o.status)).toEqual(["failed", "converted"]);
        expect(outcomes[0].artifactPath).toBeUndefined();
        expect(outcomes[0].reason).toMatch(/no artifact/i);
      });

      it("starts each document's own run on a fresh profile", async () => {
        // A killed LibreOffice leaves its profile behind mid-write, lock and
        // all; a run that inherits it may refuse to start or reuse its state.
        const sources = [await corpusFile("a.doc", "x"), await corpusFile("b.doc", "y")];
        const converter = dyingConverter({ "a.doc": "one two", "b.doc": "three four" }, (inputs) =>
          inputs.length > 1 ? { code: 137 } : {}
        );

        await convertOfficeFiles(sources, deps(converter));

        const profiles = converter.calls.map((c) => c.profileDir);
        expect(new Set(profiles).size).toBe(3);
      });
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

    it("quotes the converter's ERROR, not the warning it prints on every run", async () => {
      // The runtime image has no JRE (the recommends that would pull one in are
      // suppressed on purpose), so every single batch prints
      // "Warning: failed to launch javaldx" as its FIRST stderr line. Taking
      // the first non-empty line therefore attaches a benign, permanent
      // warning to every document-level failure — sending an operator after a
      // Java problem that does not exist, and hiding the one line that says
      // what actually happened. Verified verbatim against the real binary.
      const sources = [await corpusFile("broken.docx", "truncated zip")];
      const converter: FakeConverter = {
        calls: [],
        run: async (call) => {
          converter.calls.push(call);
          return {
            code: 0,
            signal: null,
            stderr:
              "Warning: failed to launch javaldx - java may not function correctly\n" +
              "Error: source file could not be loaded\n",
          };
        },
      };

      const outcomes = await convertOfficeFiles(sources, deps(converter));

      expect(outcomes[0].status).toBe("failed");
      expect(outcomes[0].reason).toContain("source file could not be loaded");
      expect(outcomes[0].reason).not.toContain("javaldx");
    });

    it("does not invent a cause when the converter said nothing at all", async () => {
      const sources = [await corpusFile("broken.docx", "truncated zip")];
      const converter = fakeConverter({ outputs: { "broken.docx": null } });
      // fakeConverter writes the real error line; blank it to model a silent run.
      const silent: FakeConverter = {
        calls: converter.calls,
        run: async (call) => {
          await converter.run(call);
          return { code: 0, signal: null, stderr: "" };
        },
      };

      const outcomes = await convertOfficeFiles(sources, deps(silent));

      expect(outcomes[0].status).toBe("failed");
      expect(outcomes[0].reason).toMatch(/no artifact/i);
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

  describe("a failing artifact store is infrastructure, not a verdict", () => {
    // The whole point of the failed/infrastructure split is that a squeeze on
    // the machine must never brand documents unreadable. A full or unwritable
    // artifact volume is exactly such a squeeze — so it has to arrive as an
    // outcome the caller can retry, not as an exception that aborts the run and
    // throws away every batch that already succeeded.

    it("keeps the outcomes of earlier batches when the store stops accepting artifacts", async () => {
      const sources = await Promise.all(
        Array.from({ length: 4 }, (_, i) => corpusFile(`f${i}.doc`, `body ${i}`))
      );
      const outputs = Object.fromEntries(sources.map((s, i) => [`f${i}.doc`, `body ${i}`]));
      const store = new OfficeArtifactStore(storeDir);
      let stored = 0;
      store.put = async () => {
        if (++stored > 2) throw Object.assign(new Error("ENOSPC: no space left on device"), {});
        return join(storeDir, `artifact-${stored}.pdf`);
      };

      const outcomes = await convertOfficeFiles(
        sources,
        deps(fakeConverter({ outputs }), { store, batchSize: 2 })
      );

      expect(outcomes.map((o) => o.status)).toEqual([
        "converted",
        "converted",
        "infrastructure",
        "infrastructure",
      ]);
      expect(outcomes[2].reason).toMatch(/store/i);
    });

    it("reports the whole batch as infrastructure when staging cannot be created", async () => {
      const sources = [await corpusFile("a.doc", "alpha"), await corpusFile("b.doc", "bravo")];
      const store = new OfficeArtifactStore(storeDir);
      store.createStagingDir = async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      };
      const converter = fakeConverter({ outputs: {} });

      const outcomes = await convertOfficeFiles(sources, deps(converter, { store }));

      expect(outcomes.map((o) => o.status)).toEqual(["infrastructure", "infrastructure"]);
      // Nothing about the documents was learned, so the converter must not
      // even have been asked.
      expect(converter.calls).toHaveLength(0);
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

    it("accepts only a regular file as the converter's output", async () => {
      // The output directory is shared with the converter. What it leaves
      // there is taken only if it is a plain file of its own, never by
      // following a link to somewhere else.
      const elsewhere = join(tmpRoot, "elsewhere.pdf");
      await writeFile(elsewhere, "%PDF-1.4\nnot this document\n");
      const [source] = [await corpusFile("a.doc", "x")];
      const linking: RunConverter = async (call) => {
        await symlink(elsewhere, join(call.outDir, "0.pdf"));
        return { code: 0, signal: null, stderr: "" };
      };

      const [outcome] = await convertOfficeFiles([source], {
        ...deps(fakeConverter({ outputs: {} })),
        runConverter: linking,
      });

      expect(outcome.status).toBe("failed");
      expect(outcome.reason).toMatch(/not a regular file/);
      expect(await listTree(join(storeDir))).not.toContainEqual(expect.stringMatching(/\.pdf$/));
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

describe("legacy workbooks (#1373)", () => {
  /** A count that must never be asked: a converted workbook is not a PDF. */
  const noPdfCount = async (): Promise<number> => {
    throw new Error("a converted workbook was handed to the PDF reader");
  };

  it("stores a legacy workbook as the workbook it converts to, not as a PDF", async () => {
    const sources = [await corpusFile("lieferanten/Preise.xls", "biff bytes")];
    const converter = fakeConverter({ outputs: { "Preise.xls": "Artikel Preis" } });
    const store = new OfficeArtifactStore(storeDir);

    const outcomes = await convertOfficeFiles(
      sources,
      deps(converter, { store, countPdfWords: noPdfCount })
    );

    expect(outcomes[0].status).toBe("converted");
    expect(outcomes[0].artifactPath).toMatch(/\.xlsx$/);
    const hash = createHash("sha256").update("biff bytes").digest("hex");
    expect(await store.get(hash, ".xlsx")).toBe(outcomes[0].artifactPath);
    expect(await store.get(hash)).toBeNull();
  });

  it("says plainly that nothing checked the workbook, rather than calling it ok", async () => {
    // The word-count tripwire compares the converted PDF against an
    // independent extractor. A workbook has no PDF, and the spreadsheet reader
    // skips hidden sheets, rows and columns the source still holds — a count
    // would fail on exactly the files it should pass.
    const sources = [await corpusFile("Preise.xls", "biff bytes")];
    const converter = fakeConverter({ outputs: { "Preise.xls": "Artikel Preis" } });
    const countSourceWords = vi.fn(async () => 999);

    const [outcome] = await convertOfficeFiles(
      sources,
      deps(converter, { countPdfWords: noPdfCount, countSourceWords })
    );

    expect(outcome.verification).toMatchObject({
      status: "unverified",
      sourceWords: null,
      pdfWords: null,
    });
    expect(countSourceWords).not.toHaveBeenCalled();
  });

  it("never hands a workbook and a page-shaped document to the same converter run", async () => {
    // One LibreOffice process converts to one target format.
    const sources = [
      await corpusFile("a.doc", "word"),
      await corpusFile("b.xls", "sheet"),
      await corpusFile("c.pptx", "slides"),
      await corpusFile("d.xls", "another sheet"),
    ];
    const converter = fakeConverter({
      outputs: { "a.doc": "one", "b.xls": "two", "c.pptx": "three", "d.xls": "four" },
    });

    const outcomes = await convertOfficeFiles(
      sources,
      deps(converter, {
        countPdfWords: async (path) => {
          expect(path).not.toMatch(/\.xlsx$/);
          return fakeCountPdfWords(path);
        },
      })
    );

    expect(outcomes.map((o) => o.status)).toEqual([
      "converted",
      "converted",
      "converted",
      "converted",
    ]);
    expect(outcomes.map((o) => extname(o.artifactPath!))).toEqual([
      ".pdf",
      ".xlsx",
      ".pdf",
      ".xlsx",
    ]);
    const kinds = converter.calls.map((call) => [
      ...new Set(call.inputs.map((input) => extname(input) === ".xls")),
    ]);
    expect(kinds.every((k) => k.length === 1)).toBe(true);
  });

  it("finds a workbook converted on an earlier run without converting it again", async () => {
    const sources = [await corpusFile("Preise.xls", "biff bytes")];
    const store = new OfficeArtifactStore(storeDir);
    const first = fakeConverter({ outputs: { "Preise.xls": "Artikel Preis" } });
    await convertOfficeFiles(sources, deps(first, { store, countPdfWords: noPdfCount }));

    const second = fakeConverter({ outputs: {} });
    const [outcome] = await convertOfficeFiles(
      sources,
      deps(second, { store, countPdfWords: noPdfCount })
    );

    expect(second.calls).toEqual([]);
    expect(outcome.status).toBe("converted");
    expect(outcome.verification?.status).toBe("cached");
    expect(outcome.artifactPath).toMatch(/\.xlsx$/);
  });

  it("converts the same bytes once per target, not once for both", async () => {
    // A `.doc` renamed to `.xls` keeps its bytes. Its PDF is no answer to a
    // request for a workbook, nor the other way round.
    const sources = [
      await corpusFile("a.doc", "same bytes"),
      await corpusFile("a.xls", "same bytes"),
    ];
    const converter = fakeConverter({ outputs: { "a.doc": "one", "a.xls": "two" } });

    const outcomes = await convertOfficeFiles(sources, deps(converter));

    expect(outcomes.map((o) => extname(o.artifactPath!))).toEqual([".pdf", ".xlsx"]);
  });

  it("reports a workbook LibreOffice could not open as this document's failure", async () => {
    const sources = [await corpusFile("kaputt.xls", "not biff")];
    const converter = fakeConverter({ outputs: { "kaputt.xls": null } });

    const [outcome] = await convertOfficeFiles(sources, deps(converter));

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toMatch(/no artifact produced/);
  });

  it("runs the workbooks of a killed batch one at a time, and collects each one's workbook", async () => {
    const sources = [await corpusFile("a.xls", "x"), await corpusFile("b.xls", "y")];
    const inner = fakeConverter({ outputs: { "a.xls": "one", "b.xls": "two" } });
    const converter: FakeConverter = {
      calls: inner.calls,
      run: async (call) => {
        if (call.inputs.length === 1) return inner.run(call);
        inner.calls.push(call);
        // Half a workbook from the process that died.
        await writeFile(join(call.outDir, "0.xlsx"), "half");
        return { code: null, signal: "SIGKILL", stderr: "" };
      },
    };

    const outcomes = await convertOfficeFiles(
      sources,
      deps(converter, { countPdfWords: noPdfCount })
    );

    expect(converter.calls.map((c) => c.inputs.length)).toEqual([2, 1, 1]);
    expect(outcomes.map((o) => o.status)).toEqual(["converted", "converted"]);
    for (const outcome of outcomes) {
      expect(await readFile(outcome.artifactPath!, "utf8")).not.toBe("half");
    }
  });
});

describe("preflight before conversion", () => {
  /** A converter that records what it was handed — kind and bytes — and converts everything. */
  function recordingConverter() {
    const seen: Array<{ staged: string; symlink: boolean; body: string }> = [];
    const run: RunConverter = async (call) => {
      for (const staged of call.inputs) {
        // One open, no follow: a symlink fails here with ELOOP instead of
        // being checked first and read later (CodeQL js/file-system-race).
        let symlink = false;
        let body = "";
        try {
          const fh = await open(staged, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          try {
            body = await fh.readFile("utf8");
          } finally {
            await fh.close();
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ELOOP") throw err;
          symlink = true;
        }
        seen.push({ staged: basename(staged), symlink, body });
        await writeFile(
          join(call.outDir, basename(staged, extname(staged)) + ".pdf"),
          "%PDF-1.4\nsome converted words\n"
        );
      }
      return { code: 0, signal: null, stderr: "" };
    };
    return { run, seen };
  }

  it("converts the bytes that were checked, from a private copy, not a link to the file on the share", async () => {
    // The share's planter can still write to the file. A symlink would let it
    // change between the check and the conversion; a copy of the checked
    // bytes cannot.
    const source = await corpusFile("a.docx", "ORIGINAL");
    const converter = recordingConverter();

    const outcomes = await convertOfficeFiles(
      [source],
      deps(
        { run: converter.run, calls: [] },
        {
          // The preparer writes the checked copy where it is told to; this
          // process gets the metadata.
          prepareSource: async (_absPath, staged) => {
            await writeFile(staged, "CHECKED COPY");
            return {
              relationshipsRemoved: 2,
              altChunksRemoved: 0,
              rtfGroupsRemoved: 0,
              unpackedBytes: null,
              contentHash: "0".repeat(64),
            };
          },
        }
      )
    );

    expect(outcomes[0].status).toBe("converted");
    expect(converter.seen).toEqual([{ staged: "0.docx", symlink: false, body: "CHECKED COPY" }]);
  });

  it("logs a document whose altChunk was cut: that content is converted without it, and not indexed", async () => {
    // An altChunk is cut rather than the whole file refused, so the rest
    // stays searchable. A cut picture link costs a
    // picture; a cut altChunk costs TEXT — the operator should be able to
    // find out which document lost some.
    const source = await corpusFile("chunked.docx", "ORIGINAL");
    const converter = recordingConverter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcomes = await convertOfficeFiles(
        [source],
        deps(
          { run: converter.run, calls: [] },
          {
            prepareSource: async (_absPath, staged) => {
              await writeFile(staged, "CHECKED COPY");
              return {
                relationshipsRemoved: 1,
                altChunksRemoved: 2,
                rtfGroupsRemoved: 0,
                unpackedBytes: null,
                contentHash: "0".repeat(64),
              };
            },
          }
        )
      );
      expect(outcomes[0].status).toBe("converted");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/chunked\.docx.*2 altChunk/);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a cut altChunk as one line, whatever the document's name holds", async () => {
    // The name is whoever put the file on the share's choice, newlines
    // included: escaped, it still names the document without writing a line of
    // its own into the server log.
    const source = await corpusFile(
      "Angebot\n[kb-office] Lohnliste.docx: cut 9 altChunk(s) — FORGED.docx",
      "ORIGINAL"
    );
    const converter = recordingConverter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcomes = await convertOfficeFiles(
        [source],
        deps(
          { run: converter.run, calls: [] },
          {
            prepareSource: async (_absPath, staged) => {
              await writeFile(staged, "CHECKED COPY");
              return {
                relationshipsRemoved: 0,
                altChunksRemoved: 2,
                rtfGroupsRemoved: 0,
                unpackedBytes: null,
                contentHash: "0".repeat(64),
              };
            },
          }
        )
      );
      expect(outcomes[0].status).toBe("converted");
      expect(warn).toHaveBeenCalledTimes(1);
      const printed = format(...warn.mock.calls[0]);
      expect(printed).not.toMatch(BREAKS_A_LINE);
      expect(printed).toContain("Angebot\\n[kb-office] Lohnliste.docx");
      expect(printed).toMatch(/cut 2 altChunk/);
    } finally {
      warn.mockRestore();
    }
  });

  describe("a source handed over as a private copy", () => {
    // The ingest hands the converter a copy on the staging volume, never the
    // share's path. The copy keeps the file's basename in a directory of its
    // own, so a line naming it reads like a real file — just not the one an
    // admin can find on the share.
    const SHARE_PATH = "/data/Personal/Lohnliste.docx";

    async function privateCopy(): Promise<OfficeSource> {
      const copy = await corpusFile("staging/source-AbC123/Lohnliste.docx", "ORIGINAL");
      return { ...copy, displayPath: SHARE_PATH };
    }

    it("names the share's file, not the copy, when an altChunk was cut", async () => {
      const source = await privateCopy();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await convertOfficeFiles(
          [source],
          deps(
            { run: recordingConverter().run, calls: [] },
            {
              prepareSource: async (_absPath, staged) => {
                await writeFile(staged, "CHECKED COPY");
                return {
                  relationshipsRemoved: 0,
                  altChunksRemoved: 2,
                  rtfGroupsRemoved: 0,
                  unpackedBytes: null,
                  contentHash: "0".repeat(64),
                };
              },
            }
          )
        );
        expect(warn).toHaveBeenCalledTimes(1);
        const printed = format(...warn.mock.calls[0]);
        expect(printed).toContain(`${SHARE_PATH}: cut 2 altChunk`);
        expect(printed).not.toContain(source.absPath);
      } finally {
        warn.mockRestore();
      }
    });

    it("names the share's file, not the copy, in a reason that quotes the copy", async () => {
      // A file system error quotes the path it was given — the copy's.
      const source = await privateCopy();
      const outcomes = await convertOfficeFiles(
        [source],
        deps(
          { run: recordingConverter().run, calls: [] },
          {
            prepareSource: async (absPath) => {
              throw new Error(`EACCES: permission denied, open '${absPath}'`);
            },
          }
        )
      );
      expect(outcomes[0].status).toBe("failed");
      expect(outcomes[0].reason).toContain(`open '${SHARE_PATH}'`);
      expect(outcomes[0].reason).not.toContain(source.absPath);
    });

    it("has the word-count oracle read the private copy, and tells it which file that is", async () => {
      // A .docx is counted from the caller's private copy — the bytes before
      // the preflight cut its external links (see "the word-count oracle
      // counts the document…" below) — whose name, in a staging directory,
      // says nothing about which document skipped its count.
      const source = await privateCopy();
      const countSourceWords = vi.fn(async () => null);
      await convertOfficeFiles(
        [source],
        deps(fakeConverter({ outputs: { "Lohnliste.docx": "words" } }), { countSourceWords })
      );
      expect(countSourceWords).toHaveBeenCalledWith(source.absPath, SHARE_PATH);
    });
  });

  it("keys the artifact on the bytes that were checked and staged, not on an earlier read of the file", async () => {
    // Keyed on a read made BEFORE the preflight's own, a file swapped in
    // between would be converted from its new bytes and stored under the old
    // bytes' hash — so the preview of the old content would serve the new
    // one, for as long as the artifact lived.
    const source = await corpusFile("swapped.doc", "{\\rtf1 FIRST}");
    const store = new OfficeArtifactStore(storeDir);
    const echoing: RunConverter = async (call) => {
      for (const staged of call.inputs) {
        const body = await readFile(staged, "utf8");
        await writeFile(
          join(call.outDir, basename(staged, extname(staged)) + ".pdf"),
          `%PDF-1.4\n${body}\n`
        );
      }
      return { code: 0, signal: null, stderr: "" };
    };

    const outcomes = await convertOfficeFiles(
      [source],
      deps(
        { run: echoing, calls: [] },
        {
          store,
          prepareSource: async (absPath, staged) => {
            // The planter rewrites the file after the run hashed it, before
            // the preflight reads it.
            await writeFile(absPath, "{\\rtf1 SECOND}");
            return stageOfficeSourceIsolated(absPath, staged);
          },
        }
      )
    );

    expect(outcomes[0].status).toBe("converted");
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(await store.get(sha("{\\rtf1 FIRST}"))).toBeNull();
    const artifact = await store.get(sha("{\\rtf1 SECOND}"));
    expect(artifact).not.toBeNull();
    expect(await readFile(artifact!, "utf8")).toContain("SECOND");
  });

  it("books a refused file as a document-level failure, with the reason, and converts its neighbours", async () => {
    const [bad, good] = [await corpusFile("bad.doc", "x"), await corpusFile("good.doc", "y")];
    const converter = recordingConverter();

    const outcomes = await convertOfficeFiles(
      [bad, good],
      deps(
        { run: converter.run, calls: [] },
        {
          prepareSource: async (absPath) => {
            if (absPath === bad.absPath) {
              throw new OfficeFileRejectedError("unexpected_content", "this .doc is really HTML");
            }
            return null;
          },
        }
      )
    );

    // `failed`, not `infrastructure`: nothing about this document will
    // convert on a retry, and it lands on the unreadable list.
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "converted"]);
    expect(outcomes[0].reason).toContain("this .doc is really HTML");
    expect(converter.seen.map((s) => s.staged)).toEqual(["1.doc"]);
  });

  it("with the real preflight, never hands a renamed HTML file to the converter", async () => {
    // LibreOffice picks its import filter from the content: an HTML file named
    // .doc is imported by Writer/Web, which fetches every <img src>.
    const html = await corpusFile("invoice.doc", "<html><img src='http://10.0.0.5/x.png'></html>");
    const converter = recordingConverter();

    const outcomes = await convertOfficeFiles(
      [html],
      deps({ run: converter.run, calls: [] }, { prepareSource: undefined })
    );

    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].reason).toMatch(/not a Word or PowerPoint document/);
    expect(converter.seen).toEqual([]);
  });

  it("treats a file that vanished mid-run as unreadable, not as a crash", async () => {
    const source = await corpusFile("gone.doc", "x");
    const outcomes = await convertOfficeFiles(
      [source],
      deps(fakeConverter({ outputs: {} }), {
        prepareSource: async () => {
          throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
        },
      })
    );
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].reason).toContain("could not stage source");
  });

  it("does not trust a compressed-bomb .docx to the word-count oracle either", async () => {
    // mammoth inflates the whole archive. The oracle must refuse what the
    // preflight refuses — it opens the same file.
    const bomb = join(tmpRoot, "bomb.docx");
    await writeFile(bomb, declaredBomb(0xfffffffe, "word/document.xml"));
    expect(await countSourceWordsWithOracle(bomb)).toBeNull();
    // A null alone proves little (mammoth would fail on this archive too), so
    // pin WHO said no: the guard, in the reader child, before mammoth — whose
    // failure would come back as a plain error, not as a refusal.
    const err = await rejection(countDocxWordsIsolated(bomb));
    expect(err).toBeInstanceOf(OfficeFileRejectedError);
    expect((err as OfficeFileRejectedError).code).toBe("too_large");
    expect(err.message).not.toMatch(/needed more than/);
  });

  it("does not hand the oracle's mammoth a .docx that lies about its size, or one behind a junk prefix", async () => {
    // Both get past a declared-size check; mammoth (JSZip) would inflate the
    // whole entry before noticing. The oracle reads through the same verified
    // copy the conversion does.
    const lying = join(tmpRoot, "lying.docx");
    await writeFile(
      lying,
      replaceEntry(
        docxWith({ documentRels: relationships() }),
        "word/document.xml",
        lyingEntry("word/document.xml", {
          head: "<w:document><w:body>",
          tail: "</w:body></w:document>",
          realBytes: 256 * 1024 * 1024,
          declaredBytes: 1000,
        })
      )
    );
    const prefixed = join(tmpRoot, "prefixed.docx");
    await writeFile(
      prefixed,
      Buffer.concat([Buffer.alloc(64, 0x41), docxWith({ documentRels: relationships() })])
    );
    for (const path of [lying, prefixed]) {
      expect(await countSourceWordsWithOracle(path)).toBeNull();
      expect(await rejection(countDocxWordsIsolated(path))).toBeInstanceOf(OfficeFileRejectedError);
    }
  });
});

describe("a staged copy that cannot be written is infrastructure, not a verdict", () => {
  // The reader child writes the checked copy onto the artifact volume, up to
  // 20 copies of up to 200 MB per batch. A full or read-only volume there says
  // nothing about the document — exactly like a staging directory that cannot
  // be created, or a store that refuses the PDF — so it must be retryable.
  // Booked as a document failure, a CHANGED file would lose the version the
  // index already held to a chunkless row.
  const RTF = "{\\rtf1 checked words}";
  const runningAsRoot = process.getuid?.() === 0;

  it("books a full volume under the staged copy as infrastructure, and converts its neighbours", async () => {
    const [full, good] = [await corpusFile("full.doc", "x"), await corpusFile("good.doc", "y")];
    const converter = fakeConverter({ outputs: { "good.doc": "converted words" } });

    const outcomes = await convertOfficeFiles(
      [full, good],
      deps(converter, {
        prepareSource: async (absPath) => {
          if (absPath === full.absPath) {
            throw new StagedCopyWriteError("ENOSPC: no space left on device, write");
          }
          return null;
        },
      })
    );

    expect(outcomes.map((o) => o.status)).toEqual(["infrastructure", "converted"]);
    expect(outcomes[0].reason).toMatch(/could not write the staged copy: .*ENOSPC/);
  });

  it("with the real reader child, books a destination it cannot write to as infrastructure", async () => {
    // ENOENT on purpose: the same errno a vanished SOURCE gives, so what is
    // pinned is which side of the copy failed, not which errno came back.
    const source = await corpusFile("a.doc", RTF);
    const converter = fakeConverter({ outputs: {} });

    const outcomes = await convertOfficeFiles(
      [source],
      deps(converter, {
        prepareSource: (absPath, staged) =>
          stageOfficeSourceIsolated(absPath, join(dirname(staged), "missing", basename(staged))),
      })
    );

    expect(outcomes[0].status).toBe("infrastructure");
    expect(outcomes[0].reason).toMatch(/could not write the staged copy: .*ENOENT/);
    expect(converter.calls).toHaveLength(0);
  });

  it.skipIf(runningAsRoot)(
    "with the real reader child, books a staging directory it may not write to as infrastructure",
    async () => {
      // Skipped as root: the kernel ignores the mode bits for root, so the
      // write would succeed and the test would prove nothing.
      const source = await corpusFile("a.doc", RTF);

      const outcomes = await convertOfficeFiles(
        [source],
        deps(fakeConverter({ outputs: {} }), {
          prepareSource: async (absPath, staged) => {
            await chmod(dirname(staged), 0o500);
            return stageOfficeSourceIsolated(absPath, staged);
          },
        })
      );

      expect(outcomes[0].status).toBe("infrastructure");
      expect(outcomes[0].reason).toMatch(/could not write the staged copy: .*EACCES/);
    }
  );

  it("with the real reader child, still books a source that vanished as a document failure", async () => {
    // The other side of the line: the copy failed because of the document,
    // not because of where it was going.
    const source = await corpusFile("gone.doc", RTF);

    const outcomes = await convertOfficeFiles(
      [source],
      deps(fakeConverter({ outputs: {} }), {
        prepareSource: async (absPath, staged) => {
          await rm(absPath);
          return stageOfficeSourceIsolated(absPath, staged);
        },
      })
    );

    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].reason).toMatch(/could not stage source: .*ENOENT/);
  });
});

describe("an output the converter could not write is infrastructure, not a verdict", () => {
  // LibreOffice writes its PDFs into staging/<batch>/out — the same volume the
  // staged copies just filled. When that write fails it exits 0, writes no
  // PDF and only says so on stderr, which looks exactly like a document it
  // could not load. Booked as a document failure, a CHANGED file would lose
  // the version the index already held to a chunkless row.
  //
  // But the stderr line is not the volume's word: LibreOffice
  // prints the same `impl_store … failed … Error Area:Io` when the export
  // fails for reasons of the DOCUMENT — a deck whose every slide is hidden
  // gives `Class:Write Code:16` on a roomy disk. So the verdict comes from the
  // volume itself — a write probe and `statfs` — and stderr only says which
  // output it was.
  const runningAsRoot = process.getuid?.() === 0;

  /**
   * What the real `soffice` in the runtime image prints for an output it
   * could not store — captured with `--outdir` on a tmpfs with 4 KB left.
   */
  const implStoreFailed = (pdf: string, errorClass = "Space Code:9") =>
    `convert ${pdf.replace(/\.pdf$/, ".doc")} -> ${pdf} using filter : writer_pdf_Export\n` +
    `Error: Please verify input parameters... (SfxBaseModel::impl_store <file://${pdf}> failed: 0x909(Error Area:Io Class:${errorClass}) at ./sfx2/source/doc/sfxbasemodel.cxx:3207 at ./sfx2/source/doc/sfxbasemodel.cxx:1783)\n`;

  /** A volume as `statfs` reports it: `freeBytes` available, and plenty of inodes unless told otherwise. */
  const volumeWith =
    ({ freeBytes, freeInodes = 1_000_000 }: { freeBytes: number; freeInodes?: number }) =>
    async () => ({
      bsize: 4096,
      bavail: Math.floor(freeBytes / 4096),
      files: 2_000_000,
      ffree: freeInodes,
    });

  /** A measured nearly full volume: 4 KB left, so the probe still fits and the PDF does not. */
  const nearlyFull = volumeWith({ freeBytes: 4096 });

  /** Converts the inputs whose source maps to text, and lets `after` spoil the run. */
  function converterThat(
    outputs: Record<string, string>,
    after: (call: ConverterRun) => Promise<string>
  ): RunConverter {
    return async (call) => {
      for (const staged of call.inputs) {
        const text = outputs[basename(await realpath(staged))];
        if (text) {
          const outName = basename(staged, extname(staged)) + ".pdf";
          await writeFile(join(call.outDir, outName), `%PDF-1.4\n${text}\n`);
        }
      }
      return { code: 0, signal: null, stderr: await after(call) };
    };
  }

  it("books a missing PDF as infrastructure when the volume is nearly full, citing what LibreOffice said", async () => {
    // The volume still takes a small probe here (4 KB free), so statfs is the
    // witness, and LibreOffice's line names the output it failed to write.
    const [full, good] = [await corpusFile("full.doc", "x"), await corpusFile("good.doc", "y")];

    const outcomes = await convertOfficeFiles(
      [full, good],
      deps(fakeConverter({ outputs: {} }), {
        statfs: nearlyFull,
        runConverter: converterThat({ "good.doc": "converted words" }, async (call) =>
          implStoreFailed(join(call.outDir, "0.pdf"))
        ),
      })
    );

    expect(outcomes.map((o) => o.status)).toEqual(["infrastructure", "converted"]);
    expect(outcomes[0].reason).toMatch(/could not write the converted PDF: .*bytes free/);
    expect(outcomes[0].reason).toMatch(/impl_store/);
  });

  it("books a failed store as the document's when the volume has room: an all-hidden deck", async () => {
    // What the real binary prints for a .pptx whose every slide is hidden, on
    // a volume with gigabytes free: the same Area:Io line a full disk gives.
    // Booked as infrastructure, that deck would be converted every run and
    // never listed unsearchable, while the operator is told the disk is full.
    const deck = await corpusFile("hidden.pptx", "x");

    const outcomes = await convertOfficeFiles(
      [deck],
      deps(fakeConverter({ outputs: {} }), {
        runConverter: converterThat({}, async (call) =>
          implStoreFailed(join(call.outDir, "0.pdf"), "Write Code:16")
        ),
      })
    );

    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].reason).toMatch(/no artifact produced/);
  });

  it("books it as infrastructure whatever error class LibreOffice gives the failed store", async () => {
    // Measured against the real binary: a full tmpfs says Class:Access, a
    // nearly full one Class:Space, a target that answers ENOSPC Class:Abort.
    // The class is LibreOffice's mapping, not a signal we can draw a line on —
    // which is why the volume, not the class, decides.
    const source = await corpusFile("a.doc", "x");

    const outcomes = await convertOfficeFiles(
      [source],
      deps(fakeConverter({ outputs: {} }), {
        statfs: nearlyFull,
        runConverter: converterThat({}, async (call) =>
          implStoreFailed(join(call.outDir, "0.pdf"), "Abort Code:27")
        ),
      })
    );

    expect(outcomes[0].status).toBe("infrastructure");
  });

  it("cites the converter's store line only for the output it names", async () => {
    // stderr is batch-wide, so the line is matched to the output it names.
    // `/10.pdf` must not be read as `/0.pdf` either.
    const sources = [];
    for (let i = 0; i <= 10; i++) sources.push(await corpusFile(`f${i}.doc`, `x${i}`));

    const outcomes = await convertOfficeFiles(
      sources,
      deps(fakeConverter({ outputs: {} }), {
        batchSize: 11,
        statfs: nearlyFull,
        runConverter: converterThat(
          {},
          async (call) =>
            "Error: source file could not be loaded\n" +
            implStoreFailed(join(call.outDir, "10.pdf"))
        ),
      })
    );

    expect(outcomes[10].reason).toMatch(/impl_store/);
    for (const outcome of outcomes.slice(0, 10)) {
      expect(outcome.status).toBe("infrastructure");
      expect(outcome.reason).not.toMatch(/impl_store/);
    }
  });

  it("measures the room against the document: twice its staged size, never under the floor", async () => {
    // A PDF that did not fit needed more than was left. Its size is not known
    // (it was never written), so the staged source stands in for it: twice
    // that, and never less than MIN_FREE_OUTPUT_BYTES — and room for that
    // twice over, since LibreOffice writes the PDF once into its scratch and
    // then copies it out.
    const big = join(corpusDir, "big.pptx");
    await mkdir(corpusDir, { recursive: true });
    await writeFile(big, Buffer.alloc(12 * 1024 * 1024));
    const small = await corpusFile("small.pptx", "x");

    const outcomes = await convertOfficeFiles(
      [{ absPath: big }, small],
      deps(fakeConverter({ outputs: {} }), {
        // Room for two copies of a floor-sized PDF, not for two copies of a
        // PDF twice the big source.
        statfs: volumeWith({ freeBytes: 2 * MIN_FREE_OUTPUT_BYTES + 4 * 1024 * 1024 }),
        runConverter: converterThat({}, async () => ""),
      })
    );

    expect(outcomes.map((o) => o.status)).toEqual(["infrastructure", "failed"]);
  });

  /** A preparer that stages `stagedBytes` and reports the archive unpacking to `unpackedBytes`. */
  const stagedAs =
    (stagedBytes: number, unpackedBytes: number | null) =>
    async (_absPath: string, staged: string) => {
      await writeFile(staged, Buffer.alloc(stagedBytes));
      return {
        contentHash: "0".repeat(64),
        relationshipsRemoved: 0,
        altChunksRemoved: 0,
        rtfGroupsRemoved: 0,
        unpackedBytes,
      };
    };

  it("measures the room against the UNPACKED document, not the zipped one", async () => {
    // LibreOffice unpacks an OOXML package into scratch space while it LOADS
    // it. When that runs out it says exactly what an unloadable document says
    // — exit 0, no PDF, `source file could not be loaded` — and its scratch is
    // gone again by the time the volume is asked. Measured case: a
    // 152 KB .docx whose document.xml is 26.6 MB, on a volume left with
    // 23.6 MiB free — far above twice the zipped size, below the unpacked one.
    const source = await corpusFile("report.docx", "x");

    const outcomes = await convertOfficeFiles(
      [source],
      deps(fakeConverter({ outputs: {} }), {
        prepareSource: stagedAs(152_046, 26_600_894),
        statfs: volumeWith({ freeBytes: 24_124 * 1024 }),
        runConverter: converterThat({}, async () => "Error: source file could not be loaded\n"),
      })
    );

    expect(outcomes[0].status).toBe("infrastructure");
    expect(outcomes[0].reason).toMatch(/could not write the converted PDF: .*bytes free/);
  });

  it("asks for room for the unpacked scratch AND the PDF beside it", async () => {
    // Scratch that fits is not enough: the PDF is written to the same volume.
    // 12 MiB unpacked on a 40 MiB volume leaves less than the PDF's floor,
    // written twice.
    const [packed, legacy] = [await corpusFile("a.docx", "x"), await corpusFile("b.doc", "y")];

    const outcomes = await convertOfficeFiles(
      [packed, legacy],
      deps(fakeConverter({ outputs: {} }), {
        prepareSource: async (absPath, staged) =>
          absPath.endsWith(".docx")
            ? stagedAs(4096, 12 * 1024 * 1024)(absPath, staged)
            : // A legacy binary is not an archive: nothing to unpack, so the
              // PDF rule alone applies, and 40 MiB is room enough to judge it.
              stagedAs(4096, null)(absPath, staged),
        statfs: volumeWith({ freeBytes: 40 * 1024 * 1024 }),
        runConverter: converterThat({}, async () => ""),
      })
    );

    expect(outcomes.map((o) => o.status)).toEqual(["infrastructure", "failed"]);
  });

  it("asks for room for the PDF twice: LibreOffice writes it to its scratch, then copies it out", async () => {
    // LibreOffice exports into its TMPDIR — inside the batch, on this volume —
    // and only then copies the file into --outdir, so for a moment the PDF is
    // there twice. Measured in the runtime image: a .doc whose PDF is 5,758 KiB
    // converts with 11,592 KiB free and fails the store with 11,336 KiB —
    // exit 0, no PDF, the volume free again afterwards. Room for the PDF once
    // is not room enough, for a large document or a small one:
    // - a deck of 12 MB, a 14 MB PDF, 26 MiB free — above twice
    //   the source, below twice that again;
    // - a small .doc full of pictures: 868 KiB, a 13.6 MiB PDF (measured),
    //   on a volume with 23 MiB free — above the floor, below twice it.
    const deck = join(corpusDir, "changed.ppt");
    await mkdir(corpusDir, { recursive: true });
    await writeFile(deck, Buffer.alloc(12 * 1024 * 1024));
    const pictures = await corpusFile("pictures.doc", "y");

    const outcomes = await convertOfficeFiles(
      [{ absPath: deck }],
      deps(fakeConverter({ outputs: {} }), {
        statfs: volumeWith({ freeBytes: 26 * 1024 * 1024 }),
        runConverter: converterThat({}, async () => ""),
      })
    );
    const small = await convertOfficeFiles(
      [pictures],
      deps(fakeConverter({ outputs: {} }), {
        prepareSource: stagedAs(888_320, null),
        statfs: volumeWith({ freeBytes: 23 * 1024 * 1024 }),
        runConverter: converterThat({}, async () => ""),
      })
    );

    expect([outcomes[0].status, small[0].status]).toEqual(["infrastructure", "infrastructure"]);
    expect(outcomes[0].reason).toMatch(/could not write the converted PDF: .*bytes free/);
  });

  it("leaves a PDF that outgrew the estimate to the document — the gap the docs state", async () => {
    // The estimate is a guess about a PDF that was never written, and a
    // document of pictures beats it: LibreOffice re-encodes them. Measured in
    // the runtime image: an 8,551,936-byte .doc of 200 screenshots exports an
    // 81,919,270-byte PDF (9.6×). On a 70 MiB volume the store fails — exit 0,
    // no PDF, `impl_store … Class:Write Code:16` — and leaves 64,548,864 bytes
    // free, above the 34 MB the rule asks for. That line is byte for byte the
    // one an all-hidden deck gives on a roomy disk, so it cannot settle it:
    // the document is booked `failed`. The three docs pages say so; if the
    // rule learns to tell the two apart, this fails and they must change too.
    const manual = await corpusFile("manual.doc", "x");

    const outcomes = await convertOfficeFiles(
      [manual],
      deps(fakeConverter({ outputs: {} }), {
        prepareSource: stagedAs(8_551_936, null),
        statfs: volumeWith({ freeBytes: 64_548_864 }),
        runConverter: converterThat({}, async (call) =>
          implStoreFailed(join(call.outDir, "0.pdf"), "Write Code:16")
        ),
      })
    );

    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].reason).toMatch(/no artifact produced/);
  });

  it("gives LibreOffice its scratch space inside the batch, on the volume that is checked", async () => {
    // Left to itself LibreOffice uses the OS temp dir — the container's /tmp,
    // which no check here looks at. Inside the batch it lands on the volume
    // the probe and statfs ask, and goes when the batch does.
    const source = await corpusFile("a.doc", "x");
    const converter = fakeConverter({ outputs: { "a.doc": "one two" } });
    const seen: boolean[] = [];

    await convertOfficeFiles(
      [source],
      deps(converter, {
        runConverter: async (call) => {
          seen.push((await stat(call.tmpDir)).isDirectory());
          return converter.run(call);
        },
      })
    );

    const [call] = converter.calls;
    expect(seen).toEqual([true]);
    expect(dirname(call.tmpDir)).toBe(dirname(call.outDir));
    expect(existsSync(call.tmpDir)).toBe(false);
  });

  it("books a missing PDF as infrastructure when the volume has bytes but no inodes left", async () => {
    const source = await corpusFile("a.doc", "x");

    const outcomes = await convertOfficeFiles(
      [source],
      deps(fakeConverter({ outputs: {} }), {
        statfs: volumeWith({ freeBytes: 1024 ** 3, freeInodes: MIN_FREE_OUTPUT_INODES - 1 }),
        runConverter: converterThat({}, async () => ""),
      })
    );

    expect(outcomes[0].status).toBe("infrastructure");
    expect(outcomes[0].reason).toMatch(/inodes/);
  });

  it("does not count inodes on a filesystem that has none to count", async () => {
    // btrfs and some network filesystems report 0 total inodes: no limit, not
    // an exhausted one.
    const source = await corpusFile("a.doc", "x");

    const outcomes = await convertOfficeFiles(
      [source],
      deps(fakeConverter({ outputs: {} }), {
        statfs: async () => ({ bsize: 4096, bavail: 1024 ** 2, files: 0, ffree: 0 }),
        runConverter: converterThat({}, async () => ""),
      })
    );

    expect(outcomes[0].status).toBe("failed");
  });

  it("books a missing PDF as infrastructure when the volume cannot even say how full it is", async () => {
    const source = await corpusFile("a.doc", "x");

    const outcomes = await convertOfficeFiles(
      [source],
      deps(fakeConverter({ outputs: {} }), {
        statfs: async () => {
          throw new Error("EIO: i/o error, statfs");
        },
        runConverter: converterThat({}, async () => ""),
      })
    );

    expect(outcomes[0].status).toBe("infrastructure");
    expect(outcomes[0].reason).toMatch(/EIO/);
  });

  it.skipIf(runningAsRoot)(
    "books a missing PDF as infrastructure when the output directory can no longer be written",
    async () => {
      // No stderr line to go on (LibreOffice's stderr is capped, and a batch
      // of 20 can outrun the cap): the module asks the volume itself. Skipped
      // as root, which the mode bits do not stop.
      const source = await corpusFile("a.doc", "x");

      const outcomes = await convertOfficeFiles(
        [source],
        deps(fakeConverter({ outputs: {} }), {
          runConverter: converterThat({}, async (call) => {
            await chmod(call.outDir, 0o500);
            return "";
          }),
        })
      );

      expect(outcomes[0].status).toBe("infrastructure");
      expect(outcomes[0].reason).toMatch(/could not write the converted PDF: .*EACCES/);
    }
  );

  it("books a missing PDF as infrastructure when the output directory is gone", async () => {
    // The same question, in a shape root cannot write through either.
    const source = await corpusFile("a.doc", "x");

    const outcomes = await convertOfficeFiles(
      [source],
      deps(fakeConverter({ outputs: {} }), {
        runConverter: converterThat({}, async (call) => {
          await rm(call.outDir, { recursive: true });
          await writeFile(call.outDir, "not a directory");
          return "";
        }),
      })
    );

    expect(outcomes[0].status).toBe("infrastructure");
  });
});

describe("the word-count oracle's markup ceiling", () => {
  // mammoth's DOM costs up to ~300x the XML it parses: a 1.9 MB .docx with a
  // 31 MiB document part peaked at 2.9 GB. The oracle is a tripwire, not a
  // gate — past the ceiling it is skipped, the conversion goes on, and the
  // document is recorded unverified.
  it("skips a document with more markup than it may parse, says so, and never calls mammoth", async () => {
    const big = join(tmpRoot, "long.docx");
    await writeFile(
      big,
      docxWith({
        documentRels: relationships(),
        body: "<w:p><w:r><w:t>word</w:t></w:r></w:p>".repeat(
          Math.ceil((MAX_DOCX_MARKUP_BYTES + 1) / 37)
        ),
      })
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await countSourceWordsWithOracle(big)).toBeNull();
      // The guard's words, not mammoth's and not the heap's: refused before
      // a DOM was built.
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(
        /unverified.*bytes of markup to parse/
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("still counts a document whose picture is bigger than that ceiling", async () => {
    const photo = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      randomBytes(MAX_DOCX_MARKUP_BYTES + 1024 * 1024),
    ]);
    const withPhoto = join(tmpRoot, "photo.docx");
    await writeFile(
      withPhoto,
      docxWith({
        text: "Three words here",
        documentRels: relationships(
          `<Relationship Id="rId9" Type="${REL_IMAGE}" Target="media/photo.png"/>`
        ),
        parts: { "word/media/photo.png": photo },
      })
    );
    expect(await countSourceWordsWithOracle(withPhoto)).toBe(3);
  });
});

describe("the word-count oracle reads in a heap-capped child", () => {
  // The markup scan and mammoth can disagree about which parts are parsed, so
  // the scan alone cannot bound the oracle's memory. The scan stays the first
  // layer; the bound is the reader child's heap cap, shared with the
  // spreadsheet reader — whatever the scan misses.
  const tinyParagraphs = (bytes: number) =>
    "<w:p><w:r><w:t>a</w:t></w:r></w:p>".repeat(Math.ceil(bytes / 34));

  it("counts in a child, never in this process, and counts what mammoth counts", async () => {
    const docx = docxWith({
      text: "Größe naïve 東京 and five more words",
      documentRels: relationships(),
      body: "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell one</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
    });
    const path = join(tmpRoot, "plain.docx");
    await writeFile(path, docx);
    const inProcess = (await mammoth.extractRawText({ buffer: docx })).value
      .split(/\s+/)
      .filter(Boolean).length;
    const extract = vi.spyOn(mammoth, "extractRawText");
    try {
      expect(await countSourceWordsWithOracle(path)).toBe(inProcess);
      expect(extract).not.toHaveBeenCalled();
    } finally {
      extract.mockRestore();
    }
  });

  it("refuses a document past the child's heap — and this process stays small", async () => {
    // Inside the markup ceiling, which only predicts; the heap is the bound.
    const path = join(tmpRoot, "tiny.docx");
    await writeFile(
      path,
      docxWith({ documentRels: relationships(), body: tinyParagraphs(4 * 1024 * 1024) })
    );
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    let err: unknown;
    try {
      await countDocxWordsIsolated(path, { maxHeapMb: 64 });
    } catch (e) {
      err = e;
    } finally {
      clearInterval(sampler);
    }
    expect(err).toBeInstanceOf(OfficeFileRejectedError);
    expect((err as OfficeFileRejectedError).code).toBe("too_large");
    expect((err as Error).message).toMatch(/word-count reader/);
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(peak - baseline).toBeLessThan(200 * 1024 * 1024);
  });

  it("skips the count and says so when the reader runs out of heap — the conversion goes on unverified", async () => {
    const path = join(tmpRoot, "plain.docx");
    await writeFile(path, docxWith({ documentRels: relationships() }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const countDocxWords = vi.fn(async () => {
        throw new OfficeFileRejectedError("too_large", "reading it needed more than 384 MB");
      });
      expect(await countSourceWordsWithOracle(path, { countDocxWords })).toBeNull();
      expect(countDocxWords).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(
        /unverified.*384 MB/
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a skipped count as one line, whatever the document's name and the reason hold", async () => {
    const path = join(
      tmpRoot,
      "Angebot\n[kb-convert] Lohnliste.docx: word count skipped — FORGED.docx"
    );
    await writeFile(path, docxWith({ documentRels: relationships() }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const countDocxWords = vi.fn(async () => {
        throw new OfficeFileRejectedError(
          "too_large",
          `reading ${path} needed more than 384 MB\n${"Q".repeat(3000)}\u2028`
        );
      });
      expect(await countSourceWordsWithOracle(path, { countDocxWords })).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const printed = format(...warn.mock.calls[0]);
      expect(printed).not.toMatch(BREAKS_A_LINE);
      expect(printed.length).toBeLessThan(2000);
      expect(printed).toContain("Angebot\\n[kb-convert] Lohnliste.docx");
      expect(printed).toMatch(/unverified.*384 MB/);
    } finally {
      warn.mockRestore();
    }
  });

  it("names the document it was told it is counting, not the copy it reads", async () => {
    const path = join(tmpRoot, "0.docx");
    await writeFile(path, docxWith({ documentRels: relationships() }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const countDocxWords = vi.fn(async () => {
        throw new OfficeFileRejectedError("too_large", "reading it needed more than 384 MB");
      });
      expect(
        await countSourceWordsWithOracle(path, { countDocxWords }, "/data/Lohnliste.docx")
      ).toBeNull();
      const printed = format(...warn.mock.calls[0]);
      expect(printed).toContain("/data/Lohnliste.docx: word count skipped");
      expect(printed).not.toContain(path);
    } finally {
      warn.mockRestore();
    }
  });

  it("answers null, not a crash, when the reader breaks", async () => {
    const path = join(tmpRoot, "plain.docx");
    await writeFile(path, docxWith({ documentRels: relationships() }));
    const countDocxWords = vi.fn(async () => {
      throw new Error("the word-count reader could not be started");
    });
    expect(await countSourceWordsWithOracle(path, { countDocxWords })).toBeNull();
  });
});

describe("a .doc or .ppt whose word count fails is said in the log", () => {
  async function counted(
    name: string,
    countTextWords: OracleDeps["countTextWords"],
    displayPath = `/data/${name}`
  ) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const words = await countSourceWordsWithOracle(
        join(tmpRoot, name),
        { countTextWords },
        displayPath
      );
      return { words, printed: warn.mock.calls.map((call) => format(...call)) };
    } finally {
      warn.mockRestore();
    }
  }

  it("counts a .doc with catdoc and a .ppt with catppt, and logs nothing when it works", async () => {
    const countTextWords = vi.fn<NonNullable<OracleDeps["countTextWords"]>>(async () => 42);

    expect(await counted("Alt.doc", countTextWords)).toEqual({ words: 42, printed: [] });
    expect(await counted("Folien.ppt", countTextWords)).toEqual({ words: 42, printed: [] });
    expect(countTextWords.mock.calls.map(([bin]) => bin)).toEqual(["catdoc", "catppt"]);
  });

  it("says the check failed when the extractor does, naming the document and why", async () => {
    // A .doc that catdoc chokes on is converted with no tripwire at all; an
    // operator asking why a page went missing needs this line to know that.
    const { words, printed } = await counted(
      "0.doc",
      async () => {
        throw new Error("catdoc exited with code 2");
      },
      "/data/Alt.doc"
    );

    expect(words).toBeNull();
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain(
      "/data/Alt.doc: word count failed, unverified — catdoc exited with code 2"
    );
    expect(printed[0]).not.toContain(tmpRoot);
  });

  it("says the check was skipped, not failed, when the extractor is not installed", async () => {
    const { words, printed } = await counted("Folien.ppt", async () => {
      throw Object.assign(new Error("spawn catppt ENOENT"), { code: "ENOENT" });
    });

    expect(words).toBeNull();
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("/data/Folien.ppt: word count skipped, unverified");
  });
});

describe("a batch shared with a converter that runs as another user", () => {
  /** A preparer that writes a checked copy where it is told to, as the real one does. */
  const checked = (contentHash: string) => async (_absPath: string, staged: string) => {
    await writeFile(staged, "CHECKED COPY");
    return {
      relationshipsRemoved: 0,
      altChunksRemoved: 0,
      rtfGroupsRemoved: 0,
      unpackedBytes: null,
      contentHash,
    };
  };

  it("creates each staged input exclusively, never writing through an entry already in its place", async () => {
    // Inside the spool another process can create entries. Whatever sits at
    // a staged name before the copy is written is refused, not followed —
    // by the real preflight, which writes the copy.
    const source = { absPath: join(corpusDir, "a.docx") };
    await mkdir(corpusDir, { recursive: true });
    await writeFile(source.absPath, docxWith({ documentRels: relationships() }));
    const elsewhere = join(tmpRoot, "elsewhere.docx");
    await writeFile(elsewhere, "UNTOUCHED");
    const staging = join(tmpRoot, "staging");
    const converter = fakeConverter({ outputs: {} });

    const outcomes = await convertOfficeFiles(
      [source],
      deps(converter, {
        prepareSource: undefined,
        createStagingDir: async () => {
          await mkdir(join(staging, "in"), { recursive: true });
          await symlink(elsewhere, join(staging, "in", "0.docx"));
          return staging;
        },
      })
    );

    expect(outcomes[0]).toMatchObject({ status: "infrastructure" });
    expect(outcomes[0].reason).toMatch(/could not write the staged copy/);
    expect(await readFile(elsewhere, "utf8")).toBe("UNTOUCHED");
    expect(converter.calls).toHaveLength(0);
  });

  it("stages inputs the converter's group can read but never write, whatever the umask", async () => {
    // The converter shares the web process's group. A umask of 002 — a
    // user-private-group default — must not hand that group write access to
    // the bytes the preflight checked. The real preflight writes the copy.
    const source = { absPath: join(corpusDir, "a.docx") };
    await mkdir(corpusDir, { recursive: true });
    await writeFile(source.absPath, docxWith({ documentRels: relationships() }));
    let mode = -1;
    const run: RunConverter = async (call) => {
      mode = (await stat(call.inputs[0])).mode & 0o777;
      await writeFile(join(call.outDir, "0.pdf"), "%PDF-1.4\nconverted words\n");
      return { code: 0, signal: null, stderr: "" };
    };
    const previous = process.umask(0o002);
    try {
      await convertOfficeFiles([source], deps({ run, calls: [] }, { prepareSource: undefined }));
    } finally {
      process.umask(previous);
    }

    expect(mode).toBe(0o640);
  });

  it("keeps the documents whose own runs worked when another document's own run fails", async () => {
    // Through the sidecar, a run of one document can be refused (it left a
    // process behind, the converter restarted under it). That is about that
    // document's run, not its batch-mates'.
    const sources = [
      await corpusFile("a.doc", "alpha"),
      await corpusFile("b.doc", "bravo"),
      await corpusFile("c.doc", "charlie"),
    ];
    const run: RunConverter = async (call) => {
      if (call.inputs.length > 1) return { code: 137, signal: null, stderr: "" };
      const staged = call.inputs[0];
      if (basename(staged).startsWith("1.")) {
        throw new Error("office converter refused the batch: the converter left 1 process(es)");
      }
      await writeFile(
        join(call.outDir, basename(staged, extname(staged)) + ".pdf"),
        "%PDF-1.4\nwords here\n"
      );
      return { code: 0, signal: null, stderr: "" };
    };

    const outcomes = await convertOfficeFiles(sources, deps({ run, calls: [] }));

    expect(outcomes.map((o) => o.status)).toEqual(["converted", "infrastructure", "converted"]);
    expect(outcomes[1].reason).toMatch(/converter did not run: .*left 1 process/);
  });

  it("runs a batch that left a process behind one document at a time, as after a kill", async () => {
    // Batches are fixed slices of a sorted queue: a document that makes the
    // converter leave a process running must not take its batch-mates down
    // with it every night.
    const sources = [
      await corpusFile("a.doc", "alpha"),
      await corpusFile("b.doc", "bravo"),
      await corpusFile("c.doc", "charlie"),
    ];
    const run: RunConverter = async (call) => {
      if (call.inputs.length > 1) return { code: 0, signal: null, stderr: "", leftovers: true };
      const staged = call.inputs[0];
      if (basename(staged).startsWith("1.")) {
        return { code: 0, signal: null, stderr: "", leftovers: true };
      }
      await writeFile(
        join(call.outDir, basename(staged, extname(staged)) + ".pdf"),
        "%PDF-1.4\nwords here\n"
      );
      return { code: 0, signal: null, stderr: "" };
    };

    const outcomes = await convertOfficeFiles(sources, deps({ run, calls: [] }));

    expect(outcomes.map((o) => o.status)).toEqual(["converted", "infrastructure", "converted"]);
    expect(outcomes[1].reason).toMatch(/left a process running/);
  });

  it("gives a document's own run its checked copy without writing it a second time", async () => {
    // A killed batch is the large one; a second copy of each of its files
    // would double what it holds on the volume while its documents run alone.
    const sources = [await corpusFile("a.doc", "alpha"), await corpusFile("b.doc", "bravo")];
    const inodes: number[][] = [];
    let batchInputs: string[] = [];
    const run: RunConverter = async (call) => {
      if (call.inputs.length > 1) {
        batchInputs = call.inputs;
        return { code: 137, signal: null, stderr: "" };
      }
      const staged = call.inputs[0];
      const original = batchInputs.find((p) => basename(p) === basename(staged))!;
      inodes.push([(await stat(original)).ino, (await stat(staged)).ino]);
      await writeFile(
        join(call.outDir, basename(staged, extname(staged)) + ".pdf"),
        "%PDF-1.4\nwords here\n"
      );
      return { code: 0, signal: null, stderr: "" };
    };

    const outcomes = await convertOfficeFiles(
      sources,
      deps({ run, calls: [] }, { prepareSource: checked("7".repeat(64)) })
    );

    expect(outcomes.map((o) => o.status)).toEqual(["converted", "converted"]);
    expect(inodes).toHaveLength(2);
    for (const [original, own] of inodes) expect(own).toBe(original);
  });

  it("frees what the killed batch wrote before its documents run on their own", async () => {
    // Its PDFs and its scratch sit on the volume the re-runs and the
    // free-space check use.
    const sources = [await corpusFile("a.doc", "alpha"), await corpusFile("b.doc", "bravo")];
    let killed: { outDir: string; tmpDir: string } | null = null;
    const leftOver: boolean[] = [];
    const run: RunConverter = async (call) => {
      if (call.inputs.length > 1) {
        killed = { outDir: call.outDir, tmpDir: call.tmpDir };
        await writeFile(join(call.outDir, "0.pdf"), "%PDF-1.4\nhalf");
        await writeFile(join(call.tmpDir, "scratch"), "x");
        return { code: 137, signal: null, stderr: "" };
      }
      leftOver.push(
        existsSync(join(killed!.outDir, "0.pdf")) || existsSync(join(killed!.tmpDir, "scratch"))
      );
      const staged = call.inputs[0];
      await writeFile(
        join(call.outDir, basename(staged, extname(staged)) + ".pdf"),
        "%PDF-1.4\nwords here\n"
      );
      return { code: 0, signal: null, stderr: "" };
    };

    const outcomes = await convertOfficeFiles(sources, deps({ run, calls: [] }));

    expect(outcomes.map((o) => o.status)).toEqual(["converted", "converted"]);
    expect(leftOver).toEqual([false, false]);
  });

  it("refuses an output that is not a regular file without waiting on it", async () => {
    // Opening a FIFO for reading blocks until something writes to it, and the
    // converter can make one where its PDF should be.
    const sources = [await corpusFile("a.docx", "x"), await corpusFile("b.docx", "y")];
    const run: RunConverter = async (call) => {
      execFileSync("mkfifo", [join(call.outDir, "0.pdf")]);
      await writeFile(join(call.outDir, "1.pdf"), "%PDF-1.4\nconverted words\n");
      return { code: 0, signal: null, stderr: "" };
    };

    const outcomes = await convertOfficeFiles(
      sources,
      deps({ run, calls: [] }, { prepareSource: checked("3".repeat(64)) })
    );

    expect(outcomes.map((o) => o.status)).toEqual(["failed", "converted"]);
    expect(outcomes[0].reason).toMatch(/not a regular file/);
  }, 10_000);

  it("books an output it cannot open as that document's infrastructure failure, and keeps the rest", async () => {
    const sources = [await corpusFile("a.docx", "x"), await corpusFile("b.docx", "y")];
    const prepared = [checked("4".repeat(64)), checked("5".repeat(64))];
    let n = 0;
    const run: RunConverter = async (call) => {
      await writeFile(join(call.outDir, "0.pdf"), "%PDF-1.4\nunreadable\n");
      await chmod(join(call.outDir, "0.pdf"), 0o000);
      await writeFile(join(call.outDir, "1.pdf"), "%PDF-1.4\nconverted words\n");
      return { code: 0, signal: null, stderr: "" };
    };

    const outcomes = await convertOfficeFiles(
      sources,
      deps({ run, calls: [] }, { prepareSource: (path, staged) => prepared[n++](path, staged) })
    );

    expect(outcomes.map((o) => o.status)).toEqual(["infrastructure", "converted"]);
    expect(outcomes[0].reason).toMatch(/could not read the converter's output/);
  });

  it("keeps a conversion that worked when the converter left something it cannot remove", async () => {
    // The converter owns what it writes. A directory of its own that the web
    // process cannot enter must cost a leftover, not the run's results.
    const source = await corpusFile("a.docx", "x");
    let trap = "";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run: RunConverter = async (call) => {
      await writeFile(join(call.outDir, "0.pdf"), "%PDF-1.4\nconverted words\n");
      trap = join(call.outDir, "trap");
      await mkdir(trap);
      await writeFile(join(trap, "stuck"), "x");
      await chmod(trap, 0o500);
      return { code: 0, signal: null, stderr: "" };
    };
    try {
      const outcomes = await convertOfficeFiles(
        [source],
        deps({ run, calls: [] }, { prepareSource: checked("2".repeat(64)) })
      );

      expect(outcomes[0].status).toBe("converted");
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not remove the staged batch/));
    } finally {
      warn.mockRestore();
      if (trap) await chmod(trap, 0o700);
    }
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

describe("the word-count oracle counts the document, not the sanitized copy the converter reads", () => {
  // The preflight cuts every external relationship from the staged copy, and
  // leaves the elements that pointed at them. mammoth cannot read some of
  // what is left: a hyperlink whose relationship is gone but whose `w:anchor`
  // remains — how a link to a section of a web page is stored — and a
  // picture linked to a file, DrawingML or VML. Counting the staged copy, the oracle threw, the
  // tripwire was silently off, and a PDF that lost a third of the text was
  // indexed with no word of it in the log.
  const TEXT = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  const externalLink = (id: string, type: string, target: string) =>
    `<Relationship Id="${id}" Type="${type}" Target="${target}" TargetMode="External"/>`;
  const cases: { what: string; body: string; rel: string; pictureRelId?: string }[] = [
    {
      what: "a hyperlink to a section of a web page",
      body: '<w:p><w:hyperlink r:id="rId5" w:anchor="section-two"><w:r><w:t>the section</w:t></w:r></w:hyperlink></w:p>',
      rel: externalLink("rId5", REL_HYPERLINK, "https://example.com/page"),
    },
    {
      what: "a picture linked to a file",
      body: "",
      pictureRelId: "rId9",
      rel: externalLink("rId9", REL_IMAGE, "file:///share/logo.png"),
    },
    {
      what: "a VML picture linked to a file",
      body: '<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:imagedata r:id="rId7"/></v:shape></w:pict></w:r></w:p>',
      rel: externalLink("rId7", REL_IMAGE, "file:///share/logo.png"),
    },
  ];

  for (const { what, body, rel, pictureRelId } of cases) {
    it(`fails a conversion that lost content from a .docx holding ${what}`, async () => {
      await expectLostContentCaught("Bericht.docx", body, rel, pictureRelId);
    });
  }

  // A macro-enabled document is converted exactly like a .docx (#1431), and
  // a share from an older system writes the extension in capitals.
  for (const name of ["Vorlage.docm", "ALT.DOCX"]) {
    it(`fails a conversion that lost content from ${name}`, async () => {
      const { body, rel } = cases[0];
      await expectLostContentCaught(name, body, rel);
    });
  }

  async function expectLostContentCaught(
    name: string,
    body: string,
    rel: string,
    pictureRelId?: string
  ) {
    const absPath = join(corpusDir, name);
    const staged = `0${extname(name).toLowerCase()}`;
    await mkdir(corpusDir, { recursive: true });
    await writeFile(
      absPath,
      docxWith({ text: TEXT, documentRels: relationships(rel), body, pictureRelId })
    );

    const outcomes = await convertOfficeFiles(
      [{ absPath }],
      deps(fakeConverter({ outputs: { [staged]: "only five words survived here" } }), {
        prepareSource: undefined,
        countSourceWords: undefined,
      })
    );

    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].reason).toMatch(/conversion lost content: 5 words in the PDF vs 3\d in/);
    expect(outcomes[0].verification?.status).toBe("short");
  }

  it("counts a legacy .doc from the staged copy, which is the bytes that were checked", async () => {
    // A legacy binary is staged as it is; an RTF file under a Word name is
    // staged with its field instructions cut, and catdoc would count those.
    const source = await corpusFile("Alt.doc", "legacy");
    const countSourceWords = vi.fn(async () => null);
    await convertOfficeFiles(
      [source],
      deps(fakeConverter({ outputs: { "Alt.doc": "words" } }), { countSourceWords })
    );
    expect(countSourceWords).toHaveBeenCalledWith(expect.stringMatching(/0\.doc$/), source.absPath);
  });
});

describe("a word count that fails is said in the log", () => {
  it("logs a reader that breaks, with the document's name, and goes on unverified", async () => {
    const path = join(tmpRoot, "0.docx");
    await writeFile(path, docxWith({ documentRels: relationships() }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const countDocxWords = vi.fn(async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'indexOf')");
      });
      expect(
        await countSourceWordsWithOracle(path, { countDocxWords }, "/data/Bericht.docx")
      ).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const printed = format(...warn.mock.calls[0]);
      expect(printed).toContain("/data/Bericht.docx: word count failed, unverified");
      expect(printed).toContain("reading 'indexOf'");
      expect(printed).not.toContain(path);
    } finally {
      warn.mockRestore();
    }
  });
});
