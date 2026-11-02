/**
 * The server never holds an Office file it converts (seventh review, PR #1243).
 *
 * Staging a checked copy used to read the file into the web process and hold
 * it three times over — the original, the verified copy, the sanitized copy —
 * plus once more for the word-count oracle: one ~190 MB deck cost the server
 * +560–600 MB before LibreOffice started, and with the embedding model loaded
 * during a reindex that OOM-killed a 1 GB container. A boot-requeued run then
 * killed it again. So the preflight, the staging and the oracle's guarded read
 * run in the heap-capped reader child (`xlsx-isolated.ts`), and this process
 * gets back metadata, never bytes.
 *
 * "Never reads it" is pinned by recording every path this process opens: the
 * file-system modules are wrapped, not replaced, so everything still works and
 * only the record says who read what. The child is a separate process and is
 * not recorded — which is the point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as string[]);

/** `fn`, recording the path it is called with. */
function recorded<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    opened.push(String(args[0]));
    return fn(...args);
  };
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = {
    ...actual,
    open: recorded(actual.open),
    readFile: recorded(actual.readFile),
    copyFile: recorded(actual.copyFile),
    cp: recorded(actual.cp),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrapped = {
    ...actual,
    createReadStream: recorded(actual.createReadStream),
    readFileSync: recorded(actual.readFileSync),
    openSync: recorded(actual.openSync),
  };
  return { ...wrapped, default: wrapped };
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { convertOfficeFiles, type RunConverter } from "@/lib/knowledge/office-convert";
import { OfficeArtifactStore } from "@/lib/knowledge/office-artifacts";
import { prepareOfficeSource } from "@/lib/knowledge/office-preflight";
import { stageOfficeSourceIsolated } from "@/lib/knowledge/xlsx-isolated";
import { docxWith, relationships, REL_HYPERLINK } from "@/test-helpers/office-zip";

let tmpRoot: string;
let corpusDir: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-office-isolation-"));
  corpusDir = join(tmpRoot, "data");
  await mkdir(corpusDir, { recursive: true });
  opened.length = 0;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** A corpus file, and the hash ingest hands the converter for it (ingest hashes as it reads). */
async function corpusFile(name: string, body: Buffer | string) {
  const absPath = join(corpusDir, name);
  await writeFile(absPath, body);
  return { absPath, contentHash: createHash("sha256").update(body).digest("hex") };
}

/** A converter that keeps what it was handed and "converts" everything to a 100-word PDF. */
function keepingConverter() {
  const staged: Buffer[] = [];
  const run: RunConverter = async (call) => {
    for (const input of call.inputs) {
      staged.push(await readFile(input));
      await writeFile(
        join(call.outDir, basename(input, extname(input)) + ".pdf"),
        "%PDF-1.4\nwords\n"
      );
    }
    return { code: 0, signal: null, stderr: "" };
  };
  return { run, staged };
}

describe("the server never holds an Office file it converts (seventh review, PR #1243)", () => {
  it("stages a checked copy and counts its words without opening the file in this process", async () => {
    // An external hyperlink, so the copy really is a rewrite of the package.
    const docx = docxWith({
      text: "Five words in this document",
      documentRels: relationships(
        `<Relationship Id="rId7" Type="${REL_HYPERLINK}" Target="http://10.0.0.5/x" TargetMode="External"/>`
      ),
    });
    const source = await corpusFile("report.docx", docx);
    const converter = keepingConverter();

    const outcomes = await convertOfficeFiles([source], {
      store: new OfficeArtifactStore(join(tmpRoot, "artifacts")),
      runConverter: converter.run,
      countPdfWords: async () => 100,
      // prepareSource and countSourceWords: the production defaults.
    });
    const readHere = opened.filter((path) => path.startsWith(corpusDir));

    expect(outcomes[0]).toMatchObject({
      status: "converted",
      verification: { status: "ok", sourceWords: 5 },
    });
    expect(readHere).toEqual([]);
    // What was converted is exactly what the in-process preflight makes of it.
    const expected = await prepareOfficeSource(source.absPath);
    expect(expected.relationshipsRemoved).toBe(1);
    expect(converter.staged).toEqual([expected.data]);
  });

  it("stages RTF and legacy binaries through the child too", async () => {
    const rtf = await corpusFile("letter.doc", "{\\rtf1 Hello {\\pict 0102} world}");
    const ole2 = await corpusFile(
      "old.ppt",
      Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.alloc(504),
      ])
    );
    const converter = keepingConverter();

    const outcomes = await convertOfficeFiles([rtf, ole2], {
      store: new OfficeArtifactStore(join(tmpRoot, "artifacts")),
      runConverter: converter.run,
      countPdfWords: async () => 100,
      countSourceWords: async () => null,
    });

    expect(outcomes.map((o) => o.status)).toEqual(["converted", "converted"]);
    expect(opened.filter((path) => path.startsWith(corpusDir))).toEqual([]);
    const expected = [
      (await prepareOfficeSource(rtf.absPath)).data,
      (await prepareOfficeSource(ole2.absPath)).data,
    ];
    expect(expected[0].toString("latin1")).not.toContain("pict");
    expect(converter.staged).toEqual(expected);
  });
});

describe("a staging child that dies is handled like any reader that dies (seventh review, PR #1243)", () => {
  /** A stub reader child: `body` runs once the parent's request arrives. */
  function stubChild(name: string, body: string): string {
    const path = join(tmpRoot, `${name}.mjs`);
    writeFileSync(
      path,
      `process.send({ type: "ready" }); process.once("message", (request) => { ${body} });`
    );
    return path;
  }

  async function convertWith(entry: string) {
    const source = await corpusFile("deck.pptx", docxWith({ documentRels: relationships() }));
    const converter = keepingConverter();
    const [outcome] = await convertOfficeFiles([source], {
      store: new OfficeArtifactStore(join(tmpRoot, "artifacts")),
      runConverter: converter.run,
      countPdfWords: async () => 100,
      countSourceWords: async () => null,
      prepareSource: (absPath, staged) => stageOfficeSourceIsolated(absPath, staged, { entry }),
    });
    return { outcome, converter };
  }

  it("killed without the heap banner — the container's OOM killer: infrastructure, read again next run", async () => {
    // `failed` would brand the document unreadable and, for a CHANGED file,
    // replace the version the index holds with nothing. `infrastructure`
    // keeps it, and the next run reads the file again.
    const { outcome, converter } = await convertWith(
      stubChild("killed", `process.kill(process.pid, "SIGKILL");`)
    );
    expect(outcome.status).toBe("infrastructure");
    expect(outcome.reason).toMatch(/killed/);
    expect(converter.staged).toEqual([]);
  });

  it("crashed mid-check: infrastructure, never a verdict", async () => {
    const { outcome } = await convertWith(stubChild("crash", `process.exit(3);`));
    expect(outcome.status).toBe("infrastructure");
    expect(outcome.reason).toContain("exit code 3");
  });

  it("out of heap: a verdict on the file — refused, with the reason", async () => {
    const { outcome, converter } = await convertWith(
      stubChild(
        "oom",
        `process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n", () => process.abort());`
      )
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toMatch(/refused before conversion: .*384 MB/);
    expect(converter.staged).toEqual([]);
  });
});
