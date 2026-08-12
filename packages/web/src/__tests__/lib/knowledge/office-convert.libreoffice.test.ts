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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
