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
 * developer laptop. It is excluded from `pnpm test` and run by
 * `pnpm test:libreoffice` (vitest.libreoffice.config.ts, one file at a time),
 * which CI's `libreoffice` job runs inside the Pinchy image the pipeline
 * built, with KB_REQUIRE_SOFFICE=1 so a missing binary fails instead of
 * skipping. The canary's header says how to run it in an image locally.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";

import { convertOfficeFiles, runSoffice } from "@/lib/knowledge/office-convert";
import { OfficeArtifactStore } from "@/lib/knowledge/office-artifacts";
import { assembleZip, deflatedPart, rawPart, readZipEntries } from "@/lib/knowledge/office-zip";
import { extractPdfPages } from "@/lib/knowledge/pdf-extract";

const SOFFICE = process.env.KB_SOFFICE_BIN || "soffice";
const hasSoffice = spawnSync(SOFFICE, ["--version"], { stdio: "ignore" }).status === 0;
// CI runs this suite inside the image that ships LibreOffice, with
// KB_REQUIRE_SOFFICE=1: there a missing binary is a failure, never a skip.
if (!hasSoffice && process.env.KB_REQUIRE_SOFFICE === "1") {
  throw new Error(`KB_REQUIRE_SOFFICE=1, but "${SOFFICE} --version" did not run`);
}

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

  /**
   * Builds a real Office file out of `source` (plain text unless given) — a
   * DIFFERENT soffice invocation than the one under test. The output is named
   * after the source, so `name` must share its basename.
   */
  function buildFixture(
    filter: string,
    name: string,
    source = join(tmpRoot, "source.txt")
  ): string {
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
        source,
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

  // Ninth review, PR #1243: LibreOffice writes its PDFs onto the artifact
  // volume the staged copies just filled. A failed write there exits 0 with no
  // PDF — the same shape as an unloadable document — and must not be booked
  // as one: a changed file would lose its indexed version.
  it.skipIf(process.getuid?.() === 0)(
    "books a PDF it could not write into an unwritable output directory as infrastructure",
    async () => {
      // Skipped as root, which the mode bits do not stop; the /dev/full case
      // below is the one that runs as root (CI runs this suite as root).
      const source = buildFixture("docx", "source.docx");

      const outcomes = await convertOfficeFiles([{ absPath: source }], {
        store: new OfficeArtifactStore(join(tmpRoot, "artifacts-ro")),
        runConverter: async (run) => {
          await chmod(run.outDir, 0o500);
          return runSoffice(run);
        },
      });

      expect(outcomes[0].status).toBe("infrastructure");
      expect(outcomes[0].reason).toMatch(/could not write the converted PDF/);
    },
    180_000
  );

  it.skipIf(!existsSync("/dev/full"))(
    "books a PDF whose write ran out of space on a nearly full volume as infrastructure",
    async () => {
      // The output directory itself still takes a small file — exactly a
      // nearly full volume, where the probe passes and the PDF does not fit.
      // /dev/full answers every write with ENOSPC, for root too (Linux only),
      // so LibreOffice really fails the store; `statfs` reports what such a
      // volume reports — 4 KB left — since a test cannot fill the real one.
      const source = buildFixture("docx", "source.docx");

      const outcomes = await convertOfficeFiles([{ absPath: source }], {
        store: new OfficeArtifactStore(join(tmpRoot, "artifacts-full")),
        statfs: async () => ({ bsize: 4096, bavail: 1, files: 1_000_000, ffree: 1_000_000 }),
        runConverter: async (run) => {
          await symlink("/dev/full", join(run.outDir, "0.pdf"));
          return runSoffice(run);
        },
      });

      expect(outcomes[0].status).toBe("infrastructure");
      expect(outcomes[0].reason).toMatch(/could not write the converted PDF: .*impl_store/);
    },
    180_000
  );

  // Eleventh review, PR #1243: LibreOffice unpacks a package into scratch
  // space while LOADING it, and a load that runs out of room there says what
  // an unloadable document says — exit 0, no PDF, "source file could not be
  // loaded". The review's document: 152 KB zipped, 26.6 MB of document.xml —
  // 40,000 of these paragraphs, ~665 bytes each.
  function packageOfParagraphs(name: string, paragraphs: number): string {
    const paragraph =
      "<w:p><w:r><w:t>" +
      "The quarterly report describes revenue growth across all regions and segments. ".repeat(8) +
      "</w:t></w:r></w:p>";
    const path = join(corpusDir, name);
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(
      path,
      assembleZip([
        deflatedPart(
          "[Content_Types].xml",
          Buffer.from(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
          )
        ),
        deflatedPart(
          "_rels/.rels",
          Buffer.from(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
          )
        ),
        deflatedPart(
          "word/document.xml",
          Buffer.from(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
              paragraph.repeat(paragraphs) +
              "</w:body></w:document>"
          )
        ),
      ])
    );
    return path;
  }

  /** Bytes under `dir` right now; 0 when it is not there. */
  async function bytesUnder(dir: string): Promise<number> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      total += await stat(join(entry.parentPath, entry.name)).then(
        (info) => info.size,
        () => 0
      );
    }
    return total;
  }

  it("loads a package with its unpacked scratch inside the batch, not in the OS temp dir (eleventh review)", async () => {
    // Left to itself LibreOffice uses /tmp — a volume nothing here checks.
    // Its scratch must land in the batch, on the volume the free-space check
    // asks. Watched there while it runs: on any /tmp the scratch is seen
    // where it belongs. A fifth of the review's document — converting all of
    // it takes most of a minute, a single batch's time budget.
    const source = packageOfParagraphs("scratch.docx", 8_000);
    let peak = 0;

    const outcomes = await convertOfficeFiles([{ absPath: source }], {
      store: new OfficeArtifactStore(join(tmpRoot, "artifacts-scratch")),
      runConverter: async (run) => {
        let running = true;
        const sampler = (async () => {
          while (running) {
            peak = Math.max(peak, await bytesUnder(run.tmpDir));
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        })();
        try {
          return await runSoffice(run);
        } finally {
          running = false;
          await sampler;
        }
      },
    });

    expect(outcomes[0].status, outcomes[0].reason).toBe("converted");
    // The scratch is about the unpacked document: 5.3 MB of document.xml.
    expect(peak).toBeGreaterThan(4 * 1024 * 1024);
  }, 300_000);

  // Needs a volume too small for the scratch: CI mounts one (`--tmpfs
  // /kb-small-volume:size=24m`, KB_SMALL_VOLUME) — a test cannot shrink a
  // filesystem, and faking statfs would not make LibreOffice fail.
  it.skipIf(!process.env.KB_SMALL_VOLUME)(
    "books a document whose scratch did not fit on the volume as infrastructure, not unreadable (eleventh review)",
    async () => {
      // 24 MiB cannot hold 26.6 MB of scratch. LibreOffice gives up loading,
      // and the scratch is gone again by the time the volume is asked — the
      // review measured 23.6 MiB free afterwards, far above twice the zipped
      // size. Booked as unreadable, a changed document would lose the version
      // the index holds and be listed unsearchable.
      const source = packageOfParagraphs("unpacks-large.docx", 40_000);
      let stderr = "";

      const outcomes = await convertOfficeFiles([{ absPath: source }], {
        store: new OfficeArtifactStore(join(process.env.KB_SMALL_VOLUME!, "artifacts")),
        runConverter: async (run) => {
          const result = await runSoffice(run);
          stderr = result.stderr;
          return result;
        },
      });

      // The premise: the shape of an unloadable document, not a failed store.
      expect(stderr).toMatch(/source file could not be loaded/);
      expect(outcomes[0].status, outcomes[0].reason).toBe("infrastructure");
      expect(outcomes[0].reason).toMatch(/bytes free/);
    },
    300_000
  );

  it("books a deck whose every slide is hidden as a document failure, though LibreOffice's store fails (tenth review)", async () => {
    // The real binary exits 0, writes no PDF and prints the SAME
    // `impl_store … failed … Error Area:Io` line a full volume gives
    // (`Class:Write Code:16`) — on a disk with room. Nothing about this deck
    // changes on a retry: it belongs on the unsearchable list, and the
    // operator must not be told the disk is full.
    const fodp = join(tmpRoot, "hidden.fodp");
    await writeFile(
      fodp,
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
 xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
 xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
 office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:automatic-styles>
  <style:style style:name="hidden" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden"/></style:style>
 </office:automatic-styles>
 <office:body><office:presentation>
  ${["First hidden slide", "Second hidden slide"]
    .map(
      (title, i) => `<draw:page draw:name="S${i}" draw:style-name="hidden">
   <draw:frame svg:width="20cm" svg:height="3cm" svg:x="2cm" svg:y="2cm"><draw:text-box><text:p>${title}</text:p></draw:text-box></draw:frame>
  </draw:page>`
    )
    .join("")}
 </office:presentation></office:body>
</office:document>`
    );
    const deck = buildFixture("pptx", "hidden.pptx", fodp);
    // The fixture is what the review found: every slide `show="0"`.
    const archive = await readFile(deck);
    const slides = readZipEntries(archive)
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
      .map((entry) => {
        const part = rawPart(archive, entry);
        return (part.method === 8 ? inflateRawSync(part.data) : part.data).toString("utf8");
      });
    expect(slides).toHaveLength(2);
    for (const slide of slides) expect(slide).toMatch(/<p:sld [^>]*show="0"/);

    let stderr = "";
    const outcomes = await convertOfficeFiles([{ absPath: deck }], {
      store: new OfficeArtifactStore(join(tmpRoot, "artifacts-hidden")),
      runConverter: async (run) => {
        const result = await runSoffice(run);
        stderr = result.stderr;
        return result;
      },
    });

    // The premise: LibreOffice really does report a failed store here. If an
    // upgrade renders the deck instead, this fails rather than passing on a
    // case that no longer exists.
    expect(stderr).toMatch(/impl_store <file:[^>]*\/0\.pdf> failed:.*Error Area:Io/);
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].artifactPath).toBeUndefined();
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

/**
 * What the conversion CARRIES, measured against the real binary (#938).
 *
 * The block above proves a document survives the round trip. This one asks the
 * two questions the ingest's anchors and its privacy posture rest on, and
 * neither can be answered by reading LibreOffice's documentation:
 *
 *   1. Does a Word outline become PDF bookmarks — including from legacy
 *      `.doc`? Every heading locator depends on it, and the alternative
 *      (parsing OOXML directly) cannot read the two thirds of the reference
 *      corpus that is legacy.
 *   2. What ELSE ends up in the text layer? Conversion can surface material an
 *      author hid, and the answer decides what the knowledge base may quote.
 *
 * The findings are the reason the ingest is shaped the way it is, so they are
 * pinned here rather than described in a comment: comments and speaker notes
 * are NOT rendered, and text struck through by an unaccepted tracked change
 * IS. If a LibreOffice upgrade changes either, this fails instead of quietly
 * changing what a citation can say.
 */
describe.skipIf(!hasSoffice)("what a LibreOffice conversion carries", () => {
  let tmpRoot: string;
  let corpusDir: string;

  /**
   * Writes a flat-ODF source and converts it to `filter`, returning the Office
   * file's path.
   *
   * `base` names both sides on purpose: LibreOffice derives the output name
   * from the input's basename, so a name chosen independently would point at a
   * file the converter never wrote.
   */
  function buildFrom(base: string, sourceExt: string, xml: string, filter: string, outExt: string) {
    const source = join(tmpRoot, `${base}.${sourceExt}`);
    writeFileSync(source, xml);
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
        source,
      ],
      { encoding: "utf8" }
    );
    expect(out.status, out.stderr).toBe(0);
    return join(corpusDir, `${base}.${outExt}`);
  }

  const FODT = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:body><office:text>${body}</office:text></office:body>
</office:document>`;

  const HEADINGS_BODY =
    '<text:h text:outline-level="1">Quality management</text:h>' +
    "<text:p>Every delivery is checked against the order before it is stored.</text:p>" +
    '<text:h text:outline-level="2">Incoming goods</text:h>' +
    "<text:p>Damaged pallets are photographed and reported the same day.</text:p>";

  /** Convert one Office file and return the artifact's pages, outline and all. */
  async function pagesOf(officePath: string, storeName: string) {
    const store = new OfficeArtifactStore(join(tmpRoot, storeName));
    const [outcome] = await convertOfficeFiles([{ absPath: officePath }], { store });
    expect(outcome.status).toBe("converted");
    return extractPdfPages(outcome.artifactPath!, { outline: true });
  }

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-soffice-carries-"));
    corpusDir = join(tmpRoot, "data");
    mkdirSync(corpusDir, { recursive: true });
  }, 120_000);

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.each([
    ["docx", "docx"],
    ["doc:MS Word 97", "doc"],
  ])(
    "carries a Word outline into the PDF (%s)",
    async (filter, ext) => {
      // Legacy is the case that matters most: `.doc` is 13 of the 19 Office
      // files in the reference corpus, and no OOXML parser can read it. If the
      // outline survives here, ONE mechanism covers the whole corpus.
      const pages = await pagesOf(
        buildFrom(`headings-${ext}`, "fodt", FODT(HEADINGS_BODY), filter, ext),
        `artifacts-${ext}`
      );

      const paths = pages.flatMap((page) => page.headings ?? []).map((mark) => mark.headings);
      expect(paths).toEqual([["Quality management"], ["Quality management", "Incoming goods"]]);
    },
    180_000
  );

  it("leaves a Word comment out of the converted PDF", async () => {
    // A comment is the author talking to a colleague, not to the reader — and
    // it is not in the document they open. Indexing it would both leak it and
    // produce a citation nobody can verify.
    const body =
      '<text:h text:outline-level="1">Offer</text:h>' +
      "<text:p>The price is 100 EUR per unit." +
      "<office:annotation><dc:creator>Reviewer</dc:creator>" +
      "<text:p>COMMENTSECRET we can go down to 80</text:p></office:annotation></text:p>";

    const pages = await pagesOf(
      buildFrom("comment", "fodt", FODT(body), "docx", "docx"),
      "artifacts-comment"
    );

    const text = pages.map((page) => page.text).join(" ");
    expect(text).toContain("The price is 100 EUR");
    expect(text).not.toContain("COMMENTSECRET");
  }, 180_000);

  it("renders text an unaccepted tracked change deleted, so the index carries it too", async () => {
    // The decision #938 had to make explicitly, and it goes the other way from
    // the comment above. The struck-through text IS rendered, so it is in the
    // artifact the citation opens (#939) — and index and preview must agree.
    // Indexing anything else would either hide a passage the reader can see or
    // promise one they cannot find.
    const body =
      "<text:tracked-changes>" +
      '<text:changed-region xml:id="ct1" text:id="ct1"><text:deletion>' +
      "<office:change-info><dc:creator>A</dc:creator><dc:date>2020-01-01T00:00:00</dc:date></office:change-info>" +
      "<text:p>DELETEDPRICE the old price was 250 EUR</text:p>" +
      "</text:deletion></text:changed-region></text:tracked-changes>" +
      "<text:p>Current terms below.</text:p>" +
      '<text:change text:change-id="ct1"/>';

    const pages = await pagesOf(
      buildFrom("tracked", "fodt", FODT(body), "docx", "docx"),
      "artifacts-tracked"
    );

    expect(pages.map((page) => page.text).join(" ")).toContain("DELETEDPRICE");
  }, 180_000);

  it("maps a presentation's slide N to page N and leaves its speaker notes out", async () => {
    // Both halves of the presentation anchor in one assertion: the slide
    // number a citation names IS the page of the artifact it opens, and the
    // note the presenter wrote for themselves is not indexed.
    const fodp = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
 xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
 office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:automatic-styles>
  <style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm" style:print-orientation="landscape"/></style:page-layout>
 </office:automatic-styles>
 <office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles>
 <office:body><office:presentation>
  ${["Pricing for the coming season", "Delivery windows per supplier"]
    .map(
      (title, i) => `<draw:page draw:name="S${i}" draw:master-page-name="Default">
   <draw:frame svg:width="20cm" svg:height="3cm" svg:x="2cm" svg:y="2cm"><draw:text-box><text:p>${title}</text:p></draw:text-box></draw:frame>
   <presentation:notes><draw:frame svg:width="15cm" svg:height="5cm" svg:x="2cm" svg:y="12cm"><draw:text-box><text:p>SPEAKERNOTE${i} internal margin figures</text:p></draw:text-box></draw:frame></presentation:notes>
  </draw:page>`
    )
    .join("")}
 </office:presentation></office:body>
</office:document>`;

    const pages = await pagesOf(
      buildFrom("slides", "fodp", fodp, "pptx", "pptx"),
      "artifacts-slides"
    );

    expect(pages).toHaveLength(2);
    expect(pages[0].text).toContain("Pricing for the coming season");
    expect(pages[1].text).toContain("Delivery windows per supplier");
    expect(pages.map((page) => page.text).join(" ")).not.toContain("SPEAKERNOTE");
  }, 180_000);
});
