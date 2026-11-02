/**
 * CANARIES for release review v0.10.0, finding 1: an Office file on a mounted
 * share must not make the converter fetch from the network or embed a local
 * file. Anyone who can write to the share can plant one; the nightly reindex
 * converts it inside the web container, which has a network and can read the
 * OpenClaw workspaces.
 *
 * These drive the REAL LibreOffice against a REAL local HTTP listener with
 * crafted documents, because the only honest evidence that a setting stops a
 * fetch is a listener that heard nothing. Names are not evidence: of the
 * profile keys we tried, `Link = 2` ("never update links") by itself still
 * fetched, and a dead proxy by itself still embedded `file://` images.
 *
 * Three layers, each proven ALONE so one cannot silently carry the others:
 *   1. the full pipeline (preflight + locked profile),
 *   2. the locked profile alone (preflight bypassed — the layer that holds
 *      when the preflight has a gap),
 *   3. the preflight alone (a stock LibreOffice profile — the layer that holds
 *      when LibreOffice learns a new way to fetch),
 * plus a CONTROL: the same documents, stock profile, unsanitized, DO fetch or
 * read. A canary that cannot go red proves nothing.
 *
 * Not every vector has two layers, and each one says which it has. The review
 * of this very suite found two that the profile does NOT stop — an altChunk
 * importing embedded HTML, and an SVG picture with `<image href="file:///…">`:
 * both read local files into the PDF under the locked profile. For those the
 * preflight is the only layer (it refuses the altChunk and cuts the SVG), so
 * they are absent from layer 2 by design. And a legacy OLE2 `.doc` with a
 * linked picture has only the profile: the preflight passes binary formats
 * through untouched, so that vector is absent from layer 3.
 *
 * Gated like its sibling on `soffice`; the file header there says how to run
 * it in the runtime image (Debian's LibreOffice, the version that ships). An
 * already-built image works too, with no network at all — the listener is on
 * loopback:
 *
 *   docker run --rm --network none --user root --entrypoint sh \
 *     -v "$PWD/packages/web/src:/app/packages/web/src:ro" \
 *     -v "$PWD/packages/plugins/pinchy-files:/app/packages/plugins/pinchy-files:ro" \
 *     ghcr.io/heypinchy/pinchy:dev -c 'cd /app/packages/web && node_modules/.bin/vitest run \
 *       src/__tests__/lib/knowledge/office-convert.canary.libreoffice.test.ts'
 *
 * Run it on its own, not alongside its sibling: two LibreOffice first-starts
 * in parallel vitest workers raced on the shared extension repository and one
 * aborted (signal 6 in `syncRepositories`, LibreOffice 7.4.7).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { convertOfficeFiles, type OfficeSource } from "@/lib/knowledge/office-convert";
import { OfficeArtifactStore } from "@/lib/knowledge/office-artifacts";
import { prepareOfficeSource } from "@/lib/knowledge/office-preflight";
import { extractPdfPages } from "@/lib/knowledge/pdf-extract";
import {
  assembleZip,
  deflatedPart,
  inflatePart,
  rawPart,
  readZipEntries,
} from "@/lib/knowledge/office-zip";
import {
  docxWith,
  REL_HYPERLINK,
  REL_IMAGE,
  relationships,
  relType,
} from "@/test-helpers/office-zip";

const execFileAsync = promisify(execFile);

const SOFFICE = process.env.KB_SOFFICE_BIN || "soffice";
const hasSoffice = spawnSync(SOFFICE, ["--version"], { stdio: "ignore" }).status === 0;

// A 1x1 PNG. Any image will do: the question is whether it arrives in the PDF.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

describe.skipIf(!hasSoffice)("an Office file cannot make the converter fetch or embed", () => {
  let root: string;
  let corpus: string;
  let server: Server;
  let origin: string;
  const requests: string[] = [];

  /**
   * Which layers a vector is defended by on its own (see the header). A vector
   * missing from a layer is not a gap in the suite: it is a fact about that
   * layer, written down where the layer's test reads it.
   */
  interface Vector {
    path: string;
    /** Layer 2: the locked profile alone holds. */
    profile: boolean;
    /** Layer 3: the preflight alone holds — by refusing the file, or by cutting what it reaches for. */
    preflight: "refuses" | "sanitizes" | false;
  }

  /** Vector name -> planted file. Built once; every layer converts the same bytes. */
  const vectors = new Map<string, Vector>();

  /** Planted in every local-file vector; it must never reach a PDF's text. */
  const SECRET = "SVGSECRETMARKER";
  /** The altChunk's own text: present in a PDF only if this LibreOffice imported the chunk at all. */
  const ALT_CHUNK_BODY = "ALTCHUNKBODYMARKER";

  const drain = () => requests.splice(0, requests.length);

  function planted(
    name: string,
    body: string | Buffer,
    layers: Omit<Vector, "path"> = { profile: true, preflight: "sanitizes" }
  ): string {
    const path = join(corpus, name);
    writeFileSync(path, body);
    vectors.set(name, { path, ...layers });
    return path;
  }

  /** Text in a converted PDF, through the same pdfjs layer the indexer reads. */
  async function textOf(pdfPath: string): Promise<string> {
    return (await extractPdfPages(pdfPath)).map((page) => page.text).join(" ");
  }

  /** Images LibreOffice drew into a PDF. A document with no picture has none. */
  function imagesIn(pdfPath: string): number {
    return (
      readFileSync(pdfPath)
        .toString("latin1")
        .match(/\/Subtype\s*\/Image\b/g) ?? []
    ).length;
  }

  const linkedPicture = (target: string, type = REL_IMAGE) =>
    docxWith({
      text: "Quarterly figures for Domzale",
      documentRels: relationships(
        `<Relationship Id="rId9" Type="${type}" Target="${target}" TargetMode="External"/>`
      ),
      pictureRelId: "rId9",
    });

  /** A real .pptx made by LibreOffice, then given an externally-linked picture. */
  function plantPptx(target: string): string {
    const fodp = join(root, "base.fodp");
    writeFileSync(
      fodp,
      `<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation"><office:body><office:presentation><draw:page draw:name="p1"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="3cm"><draw:text-box><text:p>Slide words for the canary deck</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document>`
    );
    const made = spawnSync(
      SOFFICE,
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=file://${join(root, "fixture-profile")}`,
        "--convert-to",
        "pptx",
        "--outdir",
        root,
        fodp,
      ],
      { encoding: "utf8" }
    );
    expect(made.status, made.stderr).toBe(0);

    const base = readFileSync(join(root, "base.pptx"));
    const entries = readZipEntries(base);
    const text = (name: string) =>
      inflatePart(
        base,
        entries.find((e) => e.name === name)!,
        8 * 1024 * 1024
      ).toString("utf8");

    let slide = text("ppt/slides/slide1.xml");
    let rels = text("ppt/slides/_rels/slide1.xml.rels");
    rels = rels.replace(
      "</Relationships>",
      `<Relationship Id="rIdX9" Type="${REL_IMAGE}" Target="${target}" TargetMode="External"/></Relationships>`
    );
    if (!slide.includes("xmlns:r=")) {
      slide = slide.replace(
        "<p:sld ",
        `<p:sld xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `
      );
    }
    slide = slide.replace(
      "</p:spTree>",
      `<p:pic><p:nvPicPr><p:cNvPr id="99" name="x"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="rIdX9"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="1000000" y="3000000"/><a:ext cx="2000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree>`
    );
    const patched = assembleZip(
      entries.map((e) =>
        e.name === "ppt/slides/slide1.xml"
          ? deflatedPart(e.name, Buffer.from(slide))
          : e.name === "ppt/slides/_rels/slide1.xml.rels"
            ? deflatedPart(e.name, Buffer.from(rels))
            : rawPart(base, e)
      )
    );
    return planted("deck-linked-http.pptx", patched);
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pinchy-kb-canary-"));
    corpus = join(root, "data");
    mkdirSync(corpus, { recursive: true });

    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "image/png");
      res.end(PNG);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    origin = `http://127.0.0.1:${address.port}`;

    const localPng = join(root, "secret.png");
    writeFileSync(localPng, PNG);

    planted("linked-http.docx", linkedPicture(`${origin}/linked-http.png`));
    planted("linked-file.docx", linkedPicture(pathToFileURL(localPng).href));
    // A relationship LABELLED hyperlink, used as a picture link: LibreOffice
    // does not check the Type when it resolves an r:link id.
    planted(
      "mislabelled-hyperlink.docx",
      linkedPicture(`${origin}/mislabelled.png`, REL_HYPERLINK)
    );
    plantPptx(`${origin}/deck.png`);
    // The same HTML, named for three formats: LibreOffice sniffs content.
    const html = `<html><body><p>Hello html posing as an office file</p><img src="${origin}/html.png"></body></html>`;
    planted("posing.doc", html, { profile: true, preflight: "refuses" });
    planted("posing.docx", html, { profile: true, preflight: "refuses" });

    // --- What the locked profile does NOT stop (release review v0.10.0) ---
    const secretSvg = join(root, "secret.svg");
    writeFileSync(
      secretSvg,
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60"><text x="10" y="40" font-size="30">${SECRET}</text></svg>`
    );
    const svgUrl = pathToFileURL(secretSvg).href;
    const pngUrl = pathToFileURL(localPng).href;

    // An internal altChunk importing an embedded HTML part: LibreOffice's HTML
    // import draws <img src="file://…"> — a local PNG embedded, a local SVG's
    // text in the indexed text layer — whatever the profile says.
    planted(
      "altchunk-html.docx",
      docxWith({
        text: "Body words for the altChunk canary",
        documentRels: relationships(
          `<Relationship Id="rIdA" Type="${relType("aFChunk")}" Target="afchunk.htm"/>`
        ),
        body: `<w:altChunk r:id="rIdA"/>`,
        parts: {
          "word/afchunk.htm": `<html><body><p>${ALT_CHUNK_BODY}</p><img src="${pngUrl}"><img src="${svgUrl}" width="400" height="60"></body></html>`,
        },
      }),
      { profile: false, preflight: "refuses" }
    );
    // An altChunk importing a NESTED .docx — whose own relationships the
    // preflight never saw — with an externally linked picture.
    planted(
      "altchunk-nested.docx",
      docxWith({
        text: "Body words for the nested canary",
        documentRels: relationships(
          `<Relationship Id="rIdA" Type="${relType("aFChunk")}" Target="afchunk.docx"/>`
        ),
        body: `<w:altChunk r:id="rIdA"/>`,
        parts: { "word/afchunk.docx": linkedPicture(`${origin}/nested.png`) },
      }),
      { profile: true, preflight: "refuses" }
    );
    // An ordinary INTERNAL picture relationship to an SVG that reaches out.
    planted(
      "svg-picture.docx",
      docxWith({
        text: "Body words for the SVG canary",
        documentRels: relationships(
          `<Relationship Id="rId5" Type="${REL_IMAGE}" Target="media/image1.svg"/>`
        ),
        body: `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="3905000" cy="1905000"/><wp:docPr id="2" name="s"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="s"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3905000" cy="1905000"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
        parts: {
          "word/media/image1.svg": `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200"><image x="0" y="0" width="400" height="60" xlink:href="${svgUrl}"/><image x="0" y="80" width="40" height="40" xlink:href="${pngUrl}"/></svg>`,
        },
      }),
      { profile: false, preflight: "sanitizes" }
    );

    // --- What ONLY the locked profile stops ---
    // A legacy binary .doc keeps a linked picture as a link. The preflight
    // passes OLE2 through untouched, so the profile is its one layer. Written
    // by LibreOffice itself from the linked .docx files above (a stock profile
    // fetches while it writes: those requests are drained below).
    const legacyDir = join(root, "legacy");
    mkdirSync(legacyDir, { recursive: true });
    await execFileAsync(
      SOFFICE,
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=file://${join(root, "fixture-profile")}`,
        "--convert-to",
        "doc:MS Word 97",
        "--outdir",
        legacyDir,
        vectors.get("linked-http.docx")!.path,
        vectors.get("linked-file.docx")!.path,
      ],
      { timeout: 180_000 }
    );
    for (const name of ["linked-http", "linked-file"]) {
      const doc = join(corpus, `legacy-${name}.doc`);
      copyFileSync(join(legacyDir, `${name}.doc`), doc);
      expect(readFileSync(doc).subarray(0, 4).toString("hex")).toBe("d0cf11e0");
      vectors.set(`legacy-${name}.doc`, { path: doc, profile: true, preflight: false });
    }
    drain();
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  /** One stock-profile conversion to PDF. Async: see the CONTROL for why. */
  async function soffice(profile: string, outDir: string, inputs: string[]): Promise<void> {
    await execFileAsync(
      SOFFICE,
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=file://${profile}`,
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        ...inputs,
      ],
      { timeout: 180_000 }
    );
  }

  /** Planted files (all, or those `pick` selects), as conversion sources, in a stable order. */
  const sources = (pick: (v: Vector) => boolean = () => true): OfficeSource[] =>
    [...vectors.values()].filter(pick).map((v) => ({ absPath: v.path }));

  const nameOf = (path: string) => path.split("/").pop()!;

  it("CONTROL: a stock profile converting the unsanitized files DOES fetch and embed — the canary can go red", async () => {
    const outDir = join(root, "control-out");
    mkdirSync(outDir, { recursive: true });
    // ASYNC on purpose: the listener lives in THIS process, and spawnSync
    // blocks the event loop that has to answer the fetch it is waiting for.
    await soffice(
      join(root, "control-profile"),
      outDir,
      sources().map((s) => s.absPath)
    );

    const fetched = drain();
    // The http image, the mislabelled hyperlink, the pptx, the two HTML files,
    // the nested package's own link and the legacy .doc's link all reached the
    // listener...
    for (const path of [
      "/linked-http.png",
      "/mislabelled.png",
      "/deck.png",
      "/html.png",
      "/nested.png",
    ]) {
      expect(
        fetched.some((r) => r.endsWith(` ${path}`)),
        `${path} in ${fetched.join(", ")}`
      ).toBe(true);
    }
    // ...the file:// pictures were drawn into their PDFs...
    for (const name of ["linked-file", "legacy-linked-file", "svg-picture"]) {
      expect(imagesIn(join(outDir, `${name}.pdf`)), name).toBeGreaterThan(0);
    }
    // ...and a local file's TEXT reached the text layer the index reads.
    expect(await textOf(join(outDir, "svg-picture.pdf"))).toContain(SECRET);

    // Whether altChunk HTML is imported at all depends on the LibreOffice
    // version: 26.2 imports it and reads the local files (local PNG embedded,
    // local SVG's text indexed); 7.4.7 — the runtime image's — skips the chunk
    // entirely (measured). Where it is imported, it leaks; that is the claim.
    const altPdf = join(outDir, "altchunk-html.pdf");
    const altText = await textOf(altPdf);
    expect(
      !altText.includes(ALT_CHUNK_BODY) || (imagesIn(altPdf) > 0 && altText.includes(SECRET)),
      "an imported altChunk read the local files"
    ).toBe(true);
  }, 240_000);

  it("1. full pipeline: nothing is fetched, no local file is embedded, the HTML posing as Word is refused", async () => {
    const store = new OfficeArtifactStore(join(root, "artifacts-full"));
    const outcomes = await convertOfficeFiles(sources(), { store });

    expect(drain()).toEqual([]);

    const byName = new Map(outcomes.map((o) => [nameOf(o.sourcePath), o]));
    for (const name of ["posing.doc", "posing.docx"]) {
      expect(byName.get(name)!.status, name).toBe("failed");
      expect(byName.get(name)!.reason).toMatch(/not a Word or PowerPoint document/);
    }
    for (const name of ["altchunk-html.docx", "altchunk-nested.docx"]) {
      expect(byName.get(name)!.status, name).toBe("failed");
      expect(byName.get(name)!.reason).toMatch(/altChunk/);
    }
    // The documents themselves still convert: a cut link costs a picture, not
    // the text — and no local file's text or picture reaches the PDF.
    for (const name of [
      "linked-http.docx",
      "linked-file.docx",
      "mislabelled-hyperlink.docx",
      "deck-linked-http.pptx",
      "svg-picture.docx",
      "legacy-linked-http.doc",
      "legacy-linked-file.doc",
    ]) {
      const outcome = byName.get(name)!;
      expect(outcome.status, `${name}: ${outcome.reason}`).toBe("converted");
      expect(imagesIn(outcome.artifactPath!), name).toBe(0);
      expect(await textOf(outcome.artifactPath!), name).not.toContain(SECRET);
    }
  }, 240_000);

  it("2. locked profile alone (preflight bypassed): nothing is fetched or embedded, whatever the file claims to be", async () => {
    const store = new OfficeArtifactStore(join(root, "artifacts-profile"));
    // Staged as links to the ORIGINAL planted bytes — HTML posing as Word and
    // all — exactly what the converter saw before any preflight existed. Only
    // the vectors this layer holds alone (see the header for the two it does not).
    const outcomes = await convertOfficeFiles(
      sources((v) => v.profile),
      { store, prepareSource: async () => null }
    );

    expect(drain()).toEqual([]);
    for (const outcome of outcomes) {
      if (outcome.status === "converted") {
        expect(imagesIn(outcome.artifactPath!), outcome.sourcePath).toBe(0);
        expect(await textOf(outcome.artifactPath!), outcome.sourcePath).not.toContain(SECRET);
      }
    }
    // Not vacuous: the files really were converted, not all rejected —
    // including the legacy .doc, whose only layer this is.
    const converted = outcomes
      .filter((o) => o.status === "converted")
      .map((o) => nameOf(o.sourcePath));
    expect(converted.length).toBeGreaterThanOrEqual(6);
    expect(converted).toEqual(
      expect.arrayContaining(["legacy-linked-http.doc", "legacy-linked-file.doc"])
    );
  }, 240_000);

  it("3. preflight alone (stock profile): the sanitized copies make no request and embed nothing", async () => {
    const stage = join(root, "sanitized");
    mkdirSync(stage, { recursive: true });
    const staged: string[] = [];
    // Not the legacy .doc: this layer passes binary formats through untouched.
    for (const [name, vector] of vectors) {
      if (!vector.preflight) continue;
      try {
        const prepared = await prepareOfficeSource(vector.path);
        const out = join(stage, name);
        writeFileSync(out, prepared.data);
        staged.push(out);
        expect(vector.preflight, name).toBe("sanitizes");
      } catch {
        // Refused (HTML posing as Word, an altChunk): never reaches a converter.
        expect(vector.preflight, name).toBe("refuses");
      }
    }
    expect(staged.map(nameOf).sort()).toEqual(
      [...vectors]
        .filter(([, v]) => v.preflight === "sanitizes")
        .map(([n]) => n)
        .sort()
    );

    const outDir = join(root, "sanitized-out");
    mkdirSync(outDir, { recursive: true });
    await soffice(join(root, "stock-profile"), outDir, staged);

    expect(drain()).toEqual([]);
    for (const path of staged) {
      const pdf = join(
        outDir,
        `${path
          .split("/")
          .pop()!
          .replace(/\.[^.]+$/, "")}.pdf`
      );
      expect(imagesIn(pdf), path).toBe(0);
      expect(await textOf(pdf), path).not.toContain(SECRET);
    }
  }, 240_000);
});
