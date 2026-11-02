/**
 * CANARIES for release review v0.10.0, finding 1: an Office file on a mounted
 * share must not make the converter fetch from the network or embed a local
 * file. Anyone who can write to the share can plant one, and the nightly
 * reindex converts it.
 *
 * In production the converter runs in the office-converter sidecar, which has
 * no network and no secrets — office-convert.sidecar.canary.test.ts proves that
 * boundary with all of the hardening below switched off. This file proves the
 * hardening itself, layer by layer, in a process that DOES have a network: the
 * in-process converter of a developer machine, and the defence in depth the
 * sidecar keeps.
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
 * plus a CONTROL: the same documents, stock profile, unsanitized, DO fetch. A
 * canary that cannot go red proves nothing.
 *
 * Gated like its sibling on `soffice`; the file header there says how to run
 * it in the runtime image (Debian's LibreOffice, the version that ships).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { convertOfficeFiles, type OfficeSource } from "@/lib/knowledge/office-convert";
import { OfficeArtifactStore } from "@/lib/knowledge/office-artifacts";
import { prepareOfficeSource } from "@/lib/knowledge/office-preflight";
import {
  assembleZip,
  deflatedPart,
  inflatePart,
  rawPart,
  readZipEntries,
} from "@/lib/knowledge/office-zip";
import { docxWith, REL_HYPERLINK, REL_IMAGE, relationships } from "@/test-helpers/office-zip";

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

  /** Vector name -> planted file. Built once; every layer converts the same bytes. */
  const vectors = new Map<string, string>();

  const drain = () => requests.splice(0, requests.length);

  function planted(name: string, body: string | Buffer): string {
    const path = join(corpus, name);
    writeFileSync(path, body);
    vectors.set(name, path);
    return path;
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
    planted("posing.doc", html);
    planted("posing.docx", html);
  }, 120_000);

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

  /** Every planted file, as conversion sources, in a stable order. */
  const sources = (): OfficeSource[] => [...vectors.values()].map((absPath) => ({ absPath }));

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
    // The http image, the mislabelled hyperlink, the pptx and the two HTML
    // files all reached the listener...
    for (const path of ["/linked-http.png", "/mislabelled.png", "/deck.png", "/html.png"]) {
      expect(
        fetched.some((r) => r.endsWith(` ${path}`)),
        `${path} in ${fetched.join(", ")}`
      ).toBe(true);
    }
    // ...and the file:// picture was drawn into its PDF.
    expect(imagesIn(join(outDir, "linked-file.pdf"))).toBeGreaterThan(0);
  }, 240_000);

  it("1. full pipeline: nothing is fetched, no local file is embedded, the HTML posing as Word is refused", async () => {
    const store = new OfficeArtifactStore(join(root, "artifacts-full"));
    const outcomes = await convertOfficeFiles(sources(), { store });

    expect(drain()).toEqual([]);

    const byName = new Map(outcomes.map((o) => [o.sourcePath.split("/").pop()!, o]));
    for (const name of ["posing.doc", "posing.docx"]) {
      expect(byName.get(name)!.status, name).toBe("failed");
      expect(byName.get(name)!.reason).toMatch(/not a Word or PowerPoint document/);
    }
    // The documents themselves still convert: a cut link costs a picture, not the text.
    for (const name of [
      "linked-http.docx",
      "linked-file.docx",
      "mislabelled-hyperlink.docx",
      "deck-linked-http.pptx",
    ]) {
      const outcome = byName.get(name)!;
      expect(outcome.status, `${name}: ${outcome.reason}`).toBe("converted");
      expect(imagesIn(outcome.artifactPath!), name).toBe(0);
    }
  }, 240_000);

  it("2. locked profile alone (preflight bypassed): nothing is fetched or embedded, whatever the file claims to be", async () => {
    const store = new OfficeArtifactStore(join(root, "artifacts-profile"));
    // Staged as links to the ORIGINAL planted bytes — HTML posing as Word and
    // all — exactly what the converter saw before any preflight existed.
    const outcomes = await convertOfficeFiles(sources(), {
      store,
      prepareSource: async () => null,
    });

    expect(drain()).toEqual([]);
    for (const outcome of outcomes) {
      if (outcome.status === "converted") {
        expect(imagesIn(outcome.artifactPath!), outcome.sourcePath).toBe(0);
      }
    }
    // Not vacuous: the files really were converted, not all rejected.
    expect(outcomes.filter((o) => o.status === "converted").length).toBeGreaterThanOrEqual(4);
  }, 240_000);

  it("3. preflight alone (stock profile): the sanitized copies make no request and embed nothing", async () => {
    const stage = join(root, "sanitized");
    mkdirSync(stage, { recursive: true });
    const staged: string[] = [];
    for (const [name, path] of vectors) {
      try {
        const prepared = await prepareOfficeSource(path);
        const out = join(stage, name);
        writeFileSync(out, prepared.data);
        staged.push(out);
      } catch {
        // Refused (the HTML posing as Word): never reaches a converter.
      }
    }
    expect(staged.length).toBe(4);

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
    }
  }, 240_000);
});
