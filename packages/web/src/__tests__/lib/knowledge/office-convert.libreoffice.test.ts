/**
 * The other half of office-convert's coverage: office-convert.test.ts proves
 * what the module CONCLUDES from a converter run, with the subprocess faked.
 * This file proves the production adapter actually drives the real binary —
 * the argv, the private-profile flag, the staging symlinks, and the
 * "exit 0 + no artifact" detector against a genuinely unloadable input.
 *
 * Those are different questions, and only the second one catches a wrong flag.
 *
 * Gated with describe.skipIf on the presence of `soffice` (an allowed env/OS
 * conditional gate per AGENTS.md, not an untracked skip): LibreOffice is a
 * 422 MB image layer that exists in the Pinchy runtime image and on almost no
 * developer laptop. To run it:
 *
 *   docker run --rm -v "$PWD/packages/web/src:/app/packages/web/src:ro" \
 *     ghcr.io/heypinchy/pinchy:dev sh -c \
 *     'apt-get update && apt-get install -y --no-install-recommends \
 *        libreoffice-writer fonts-liberation catdoc && cd /app/packages/web && \
 *      node_modules/.bin/vitest run src/__tests__/lib/knowledge/office-convert.libreoffice.test.ts'
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { convertOfficeFiles } from "@/lib/knowledge/office-convert";
import { OfficeArtifactStore } from "@/lib/knowledge/office-artifacts";
import { extractPdfPages } from "@/lib/knowledge/pdf-extract";

const SOFFICE = process.env.KB_SOFFICE_BIN || "soffice";
const hasSoffice = spawnSync(SOFFICE, ["--version"], { stdio: "ignore" }).status === 0;

// Central/Eastern European diacritics on purpose: they are what the customer
// corpus is full of, and they are exactly what a font-starved image or a
// mangling extractor destroys.
const SOURCE_TEXT =
  "GODIČ TORKAR und Domžale prüfen die Maßnahmen.\n" +
  "The quick brown fox jumps over the lazy dog, twice over.\n" +
  "A third line so the word count is not trivially small.\n";

describe.skipIf(!hasSoffice)("convertOfficeFiles against a real LibreOffice", () => {
  let tmpRoot: string;
  let corpusDir: string;

  /** Builds a real Office file out of plain text — a DIFFERENT soffice invocation than the one under test. */
  function buildFixture(filter: string, name: string): string {
    const out = spawnSync(
      SOFFICE,
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=file://${join(tmpRoot, "fixture-profile")}`,
        "--convert-to",
        filter,
        "--outdir",
        corpusDir,
        join(tmpRoot, "source.txt"),
      ],
      { encoding: "utf8" }
    );
    expect(out.status, out.stderr).toBe(0);
    return join(corpusDir, name);
  }

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-soffice-"));
    corpusDir = join(tmpRoot, "data");
    await writeFile(join(tmpRoot, "source.txt"), SOURCE_TEXT);
  }, 120_000);

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("converts legacy and modern Word in one process, and reports an unloadable file as document-level", async () => {
    const legacy = buildFixture("doc:MS Word 97", "source.doc");
    const modern = buildFixture("docx", "source.docx");

    // A truncated OOXML archive: this is the input that makes LibreOffice
    // print "Error: source file could not be loaded", exit **0**, and write
    // nothing — while the other two files in the same batch convert.
    const broken = join(corpusDir, "broken.docx");
    await writeFile(broken, (await readFile(modern)).subarray(0, 200));

    const store = new OfficeArtifactStore(join(tmpRoot, "artifacts"));
    const outcomes = await convertOfficeFiles(
      [{ absPath: legacy }, { absPath: modern }, { absPath: broken }],
      { store }
    );

    expect(outcomes.map((o) => o.status)).toEqual(["converted", "converted", "failed"]);

    // `failed`, not `infrastructure`: nothing about this document will
    // convert on a retry, so it belongs on the unreadable list (#935).
    expect(outcomes[2].artifactPath).toBeUndefined();

    for (const outcome of outcomes.slice(0, 2)) {
      expect(outcome.artifactPath!.startsWith(join(tmpRoot, "artifacts"))).toBe(true);
      const text = (await extractPdfPages(outcome.artifactPath!))
        .map((page) => page.text)
        .join(" ");
      // Round-trip through the real renderer AND the real text layer: the
      // diacritics survive, so fonts-liberation covers the corpus.
      expect(text).toContain("GODIČ TORKAR");
      expect(text).toContain("Domžale");
      expect(text).toContain("Maßnahmen");
      expect(outcome.verification!.pdfWords).toBeGreaterThanOrEqual(20);
    }

    // .docx has an oracle in the image (mammoth); .doc only has one when
    // catdoc is installed. Either way the check must not have fired.
    expect(outcomes[1].verification!.status).toBe("ok");
    expect(["ok", "unverified"]).toContain(outcomes[0].verification!.status);

    // Nothing was written beside the originals.
    expect(
      spawnSync("ls", [corpusDir], { encoding: "utf8" }).stdout.trim().split("\n").sort()
    ).toEqual(["broken.docx", "source.doc", "source.docx"]);
  }, 180_000);

  it("serves the stored artifact on the second run without touching LibreOffice again", async () => {
    const source = buildFixture("doc:MS Word 97", "source.doc");
    const store = new OfficeArtifactStore(join(tmpRoot, "artifacts-2"));

    const first = await convertOfficeFiles([{ absPath: source }], { store });
    const second = await convertOfficeFiles([{ absPath: source }], {
      store,
      // A converter that would fail loudly if it were ever called: the
      // second run must be answered from the store alone.
      runConverter: async () => {
        throw new Error("converter must not run for content already in the store");
      },
    });

    expect(first[0].status).toBe("converted");
    expect(second[0].artifactPath).toBe(first[0].artifactPath);
    expect(second[0].verification!.status).toBe("cached");
  }, 180_000);
});
