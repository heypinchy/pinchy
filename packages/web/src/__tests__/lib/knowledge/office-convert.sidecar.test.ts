/**
 * convertOfficeFiles, wired the way production wires it: `KB_OFFICE_SPOOL_DIR`
 * is set (Dockerfile.pinchy bakes it into the image), so the web process
 * stages each batch in the spool and asks the office-converter sidecar over its
 * socket — and never spawns LibreOffice itself.
 *
 * The sidecar here is the REAL server and the REAL `runSoffice`, in this
 * process, driving a stub `soffice`. What a container adds — no network, no
 * secrets — is proven by office-convert.sidecar.canary.test.ts against the
 * shipped image; this file proves the web side actually goes there.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { convertOfficeFiles } from "@/lib/knowledge/office-convert";
import { OfficeArtifactStore } from "@/lib/knowledge/office-artifacts";
import {
  createOfficeConverterServer,
  listenOfficeConverter,
} from "@/lib/knowledge/office-converter-sidecar";
import { runSoffice } from "@/lib/knowledge/office-soffice";
import { docxWith, relationships } from "@/test-helpers/office-zip";

let root: string;
let spool: string;
let corpus: string;
let server: Server | null;
let sidecarRuns: number;
/** Where the stub records that it ran — the proof of WHO converted. */
let ranMarker: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-sc-"));
  spool = mkdtempSync(join(tmpdir(), "kb-spool-"));
  corpus = join(root, "corpus");
  ranMarker = join(root, "soffice-ran");
  server = null;
  sidecarRuns = 0;
  mkdirSync(corpus);

  // A stand-in soffice that "converts" every input to <index>.pdf in --outdir.
  const bin = join(root, "soffice");
  writeFileSync(
    bin,
    `#!/bin/sh
echo ran >> ${ranMarker}
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --outdir) out="$2"; shift 2 ;;
    -*) shift ;;
    *) base=$(basename "$1"); printf '%%PDF-1.4 stub' > "$out/\${base%.*}.pdf"; shift ;;
  esac
done
`
  );
  chmodSync(bin, 0o755);
  process.env.KB_SOFFICE_BIN = bin;
  process.env.KB_OFFICE_SPOOL_DIR = spool;
});

afterEach(async () => {
  delete process.env.KB_SOFFICE_BIN;
  delete process.env.KB_OFFICE_SPOOL_DIR;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(spool, { recursive: true, force: true });
});

async function startSidecar(): Promise<void> {
  server = createOfficeConverterServer({
    spoolDir: spool,
    runConverter: async (run) => {
      sidecarRuns++;
      return runSoffice(run);
    },
  });
  await listenOfficeConverter(server, spool);
}

function plantDocx(name: string): string {
  const path = join(corpus, name);
  writeFileSync(path, docxWith({ text: "Angebot für Domžale", documentRels: relationships() }));
  return path;
}

const counters = {
  countPdfWords: async () => 3,
  countSourceWords: async () => 3,
};

describe("convertOfficeFiles with the office-converter sidecar", () => {
  it("re-runs a batch the converter answered as leaving a process behind, one document at a time", async () => {
    let lastInputs = 0;
    server = createOfficeConverterServer({
      spoolDir: spool,
      runConverter: async (run) => {
        sidecarRuns++;
        lastInputs = run.inputs.length;
        return runSoffice(run);
      },
      leftovers: async () => (lastInputs > 1 ? [4242] : []),
      // The real server exits here; this one stays up for the re-runs.
      onLeftovers: () => {},
    });
    await listenOfficeConverter(server, spool);
    const store = new OfficeArtifactStore(join(root, "artifacts"));
    const sources = ["delta", "echo"].map((word) => {
      const absPath = join(corpus, `${word}.docx`);
      writeFileSync(absPath, docxWith({ text: `Angebot ${word}`, documentRels: relationships() }));
      return { absPath };
    });

    const outcomes = await convertOfficeFiles(sources, { store, ...counters });

    expect(
      outcomes.map((o) => o.status),
      outcomes.map((o) => o.reason).join("; ")
    ).toEqual(["converted", "converted"]);
    expect(sidecarRuns).toBe(3);
  });

  it("re-runs a killed batch one document at a time through the sidecar, and leaves the spool clean", async () => {
    // Each document's own run is a batch of its own in the spool — the only
    // shape the sidecar accepts, since it derives every path from the batch.
    server = createOfficeConverterServer({
      spoolDir: spool,
      runConverter: async (run) => {
        sidecarRuns++;
        if (run.inputs.length > 1) return { code: 137, signal: null, stderr: "", timedOut: false };
        return runSoffice(run);
      },
    });
    await listenOfficeConverter(server, spool);
    const store = new OfficeArtifactStore(join(root, "artifacts"));
    // Different content each: identical documents would share one conversion.
    const sources = ["alpha", "bravo", "charlie"].map((word) => {
      const absPath = join(corpus, `${word}.docx`);
      writeFileSync(absPath, docxWith({ text: `Angebot ${word}`, documentRels: relationships() }));
      return { absPath };
    });

    const outcomes = await convertOfficeFiles(sources, { store, ...counters });

    expect(
      outcomes.map((o) => o.status),
      outcomes.map((o) => o.reason).join("; ")
    ).toEqual(["converted", "converted", "converted"]);
    expect(sidecarRuns).toBe(4);
    expect(await readdir(spool)).toEqual(["converter.sock"]);
  });

  it("converts through the sidecar and commits the PDF into a store outside the spool", async () => {
    await startSidecar();
    // A different directory tree than the spool. Here both are on one
    // filesystem, so the commit is still a rename; the cross-volume copy that
    // production needs is covered by office-artifacts.exdev.test.ts and by
    // docker-smoke's check-office-converter run.
    const store = new OfficeArtifactStore(join(root, "artifacts"));
    const source = plantDocx("Angebot.docx");

    const [outcome] = await convertOfficeFiles([{ absPath: source }], { store, ...counters });

    expect(outcome.status, outcome.reason).toBe("converted");
    expect(sidecarRuns).toBe(1);
    expect(outcome.artifactPath!.startsWith(join(root, "artifacts"))).toBe(true);
    expect(await readFile(outcome.artifactPath!, "utf8")).toBe("%PDF-1.4 stub");
    // The batch is gone from the spool once it is committed; only the socket stays.
    expect(await readdir(spool)).toEqual(["converter.sock"]);
  });

  it("does not convert in-process when the sidecar is not there — the document stays retryable", async () => {
    // KB_OFFICE_SPOOL_DIR is set, nothing listens: an upgrade that kept the
    // old docker-compose.yml. The local soffice stub WOULD succeed, so a
    // silent fallback to in-process conversion would show up here as
    // `converted` — which is exactly the capability the sidecar removes.
    const store = new OfficeArtifactStore(join(root, "artifacts"));
    const source = plantDocx("Angebot.docx");

    const [outcome] = await convertOfficeFiles([{ absPath: source }], { store, ...counters });

    expect(outcome.status).toBe("infrastructure");
    expect(outcome.reason).toMatch(/office-converter service/);
    expect(existsSync(ranMarker)).toBe(false);
  });

  it("names the converter's own memory limit when the sidecar's soffice is killed", async () => {
    server = createOfficeConverterServer({
      spoolDir: spool,
      runConverter: async () => ({ code: null, signal: "SIGKILL", stderr: "", timedOut: false }),
    });
    await listenOfficeConverter(server, spool);
    const store = new OfficeArtifactStore(join(root, "artifacts"));

    const [outcome] = await convertOfficeFiles([{ absPath: plantDocx("a.docx") }], {
      store,
      ...counters,
    });

    expect(outcome.status).toBe("infrastructure");
    expect(outcome.reason).toMatch(/OFFICE_CONVERTER_MEM_LIMIT/);
  });
});
