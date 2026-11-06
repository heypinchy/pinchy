/**
 * CANARY for the boundary itself: LibreOffice inside the shipped
 * `office-converter` service cannot reach the network, and finds no secret to
 * read — with EVERY hardening from PR #1243 switched off.
 *
 * office-convert.canary.libreoffice.test.ts proves the profile and the
 * preflight each stop the fetch on their own. Those are settings of a process
 * that still HAS a network; this file proves the sidecar takes the network
 * away. So it runs the stock LibreOffice profile on the unsanitized files —
 * the converter as it was before any of the hardening existed — and asks only
 * one question: did anything arrive?
 *
 * - CONTROL: the same image on an ordinary bridge network DOES fetch from a
 *   listener on the Docker host, and a bare socket DOES connect to it. Without
 *   this, "nothing arrived" could mean a wrong address rather than a boundary.
 * - BOUNDARY: `docker compose run` of the service exactly as docker-compose.yml
 *   declares it — not a hand-written `docker run --network none`, which would
 *   prove a flag rather than the file every install runs — converts the same
 *   files and the listener hears nothing; a socket to the same address fails
 *   with ENETUNREACH; `lo` is the only interface.
 * - SECRETS: inside the service there is no config, no secret file, no corpus
 *   and no secret in the environment for a `file://` link to draw in. And the
 *   reference that the profile does NOT stop — a Word document nested as an
 *   INTERNAL altChunk, whose picture is a `file://` link (#1243 review) — is
 *   proven both ways: CONTROL, with files at a path the web container has
 *   (an agent workspace under /openclaw-config), draws the picture in and
 *   turns an SVG's text into searchable PDF text; the shipped service, where
 *   that path does not exist, converts the same document with neither.
 *
 * Needs Docker and the Pinchy image, so it is gated (an allowed env gate per
 * AGENTS.md) on `KB_SIDECAR_CANARY_VERSION`: the tag of
 * `ghcr.io/heypinchy/pinchy` to test. CI's docker-smoke job runs it against the
 * PR's image (`latest` there). Locally, against an image you built:
 *
 *   docker build -t ghcr.io/heypinchy/pinchy:local -f Dockerfile.pinchy .
 *   KB_SIDECAR_CANARY_VERSION=local pnpm -C packages/web exec vitest run \
 *     src/__tests__/lib/knowledge/office-convert.sidecar.canary.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { extractPdfPages } from "@/lib/knowledge/pdf-extract";
import {
  docxWith,
  REL_HYPERLINK,
  REL_IMAGE,
  relationships,
  zipOf,
} from "@/test-helpers/office-zip";

const execFileAsync = promisify(execFile);

const VERSION = process.env.KB_SIDECAR_CANARY_VERSION;
const IMAGE = `ghcr.io/heypinchy/pinchy:${VERSION}`;
const REPO_ROOT = resolve(__dirname, "../../../../../..");
/** Its own Compose project: the canary must not touch a running stack's volumes. */
const PROJECT = "pinchy-office-canary";

// A 1x1 PNG. Any image will do: the question is whether it arrives.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** The soffice argv of a conversion with a STOCK profile — none of #1243's settings. */
function stockConversion(name: string, inputs: string[]): string[] {
  return [
    "--headless",
    "--norestore",
    `-env:UserInstallation=file:///canary/${name}-profile`,
    "--convert-to",
    "pdf",
    "--outdir",
    `/canary/${name}-out`,
    ...inputs.map((input) => `/canary/in/${input}`),
  ];
}

/**
 * Where a file:// reference aims: a path that EXISTS in the web container —
 * an agent's workspace under /openclaw-config. The CONTROL mounts files there
 * to stand in for the web container; the shipped converter has no such path.
 */
const WEB_ONLY_DIR = "/openclaw-config/workspaces/agent-a";
const SECRET_TEXT = "PINCHYSECRET4711";
const SECRET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60"><text x="10" y="40" font-size="30">${SECRET_TEXT}</text></svg>`;

/**
 * A .docx whose body imports an embedded HTML part through an INTERNAL
 * `aFChunk` relationship — and the HTML pulls in local files with
 * <img src="file://…">. Internal, so it is no external link for a preflight to
 * cut; LibreOffice resolves the HTML's references even under the locked
 * profile (found in the #1243 review). Only having nothing at those paths
 * makes it harmless.
 */
function altChunkDocx(chunk: { name: string; body: string | Buffer; contentType: string }): Buffer {
  const ext = chunk.name.split(".").pop();
  return zipOf({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="${ext}" ContentType="${chunk.contentType}"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": relationships(
      `<Relationship Id="rIdAlt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="${chunk.name}"/>`
    ),
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Altchunk carrier document</w:t></w:r></w:p><w:altChunk r:id="rIdAlt"/><w:p><w:r><w:t>After the chunk</w:t></w:r></w:p></w:body></w:document>`,
    [`word/${chunk.name}`]: chunk.body,
  });
}

async function pdfText(pdf: string): Promise<string> {
  return (await extractPdfPages(pdf)).map((page) => page.text).join(" ");
}

/** Connects to host:port and prints what happened. */
const probe = (host: string, port: number) =>
  `const s=require('net').connect(${port},'${host}');` +
  `s.setTimeout(5000,()=>{console.log('TIMEOUT');process.exit(0)});` +
  `s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});` +
  `s.on('error',e=>{console.log(e.code);process.exit(0)})`;

describe.skipIf(!VERSION)(
  "the office-converter service cannot reach the network or read secrets",
  () => {
    let root: string;
    let server: Server;
    let port: number;
    /** The Docker host as a container on a bridge network sees it — an IP, never a name. */
    let hostIp: string;
    const requests: string[] = [];
    const inputs: string[] = [];

    const drain = () => requests.splice(0, requests.length);

    /** `docker run` on the default bridge network, with the host reachable. */
    async function bridged(
      entrypoint: string,
      args: string[],
      mounts: string[] = []
    ): Promise<string> {
      const { stdout } = await execFileAsync(
        "docker",
        [
          "run",
          "--rm",
          "--add-host",
          "canary-host:host-gateway",
          "-v",
          `${root}:/canary`,
          ...mounts.flatMap((m) => ["-v", m]),
          "--entrypoint",
          entrypoint,
          IMAGE,
          ...args,
        ],
        { timeout: 240_000 }
      );
      return stdout;
    }

    /** The `office-converter` service, as docker-compose.yml declares it. */
    async function asShipped(entrypoint: string, args: string[]): Promise<string> {
      const { stdout } = await execFileAsync(
        "docker",
        [
          "compose",
          "-f",
          join(REPO_ROOT, "docker-compose.yml"),
          "-p",
          PROJECT,
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "-v",
          `${root}:/canary`,
          "--entrypoint",
          entrypoint,
          "office-converter",
          ...args,
        ],
        { timeout: 240_000, env: { ...process.env, PINCHY_VERSION: VERSION } }
      );
      return stdout;
    }

    function imagesIn(pdf: string): number {
      return (
        readFileSync(pdf)
          .toString("latin1")
          .match(/\/Subtype\s*\/Image\b/g) ?? []
      ).length;
    }

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "pinchy-sidecar-canary-"));
      // The service runs as uid 998; the bind mount must be writable for it.
      chmodSync(root, 0o777);
      for (const dir of [
        "in",
        "control-out",
        "control-alt-out",
        "boundary-out",
        "boundary-alt-out",
      ]) {
        mkdirSync(join(root, dir));
        chmodSync(join(root, dir), 0o777);
      }

      server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.setHeader("content-type", "image/png");
        res.end(PNG);
      });
      // Every interface: the request comes from a container, not from loopback.
      await new Promise<void>((done) => server.listen(0, "0.0.0.0", done));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      port = address.port;

      hostIp = (
        await bridged("node", [
          "-e",
          "require('dns').lookup('canary-host',(e,a)=>{if(e)throw e;console.log(a)})",
        ])
      ).trim();
      expect(hostIp).toMatch(/^[0-9a-f.:]+$/);
      const origin = `http://${hostIp.includes(":") ? `[${hostIp}]` : hostIp}:${port}`;

      writeFileSync(join(root, "secret.png"), PNG);
      const plant = (name: string, body: string | Buffer) => {
        writeFileSync(join(root, "in", name), body);
        inputs.push(name);
      };
      const linked = (target: string, type = REL_IMAGE) =>
        docxWith({
          text: "Quarterly figures for Domzale",
          documentRels: relationships(
            `<Relationship Id="rId9" Type="${type}" Target="${target}" TargetMode="External"/>`
          ),
          pictureRelId: "rId9",
        });
      plant("linked-http.docx", linked(`${origin}/linked-http.png`));
      plant("mislabelled-hyperlink.docx", linked(`${origin}/mislabelled.png`, REL_HYPERLINK));
      plant(
        "posing.doc",
        `<html><body><p>Hello html posing as Word</p><img src="${origin}/html.png"></body></html>`
      );
      plant("linked-file.docx", linked("file:///canary/secret.png"));

      writeFileSync(join(root, "secret.svg"), SECRET_SVG);
      // A Word document nested as an altChunk, whose picture is a file://
      // link. The HTML chunk form does not import in this LibreOffice; the
      // nested-document form does, and CONTROL proves it reads the file.
      const nested = (target: string) =>
        altChunkDocx({
          name: "chunk.docx",
          body: docxWith({
            text: "Embedded chunk",
            documentRels: relationships(
              `<Relationship Id="rId9" Type="${REL_IMAGE}" Target="${target}" TargetMode="External"/>`
            ),
            pictureRelId: "rId9",
          }),
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        });
      plant("altchunk-png.docx", nested(`file://${WEB_ONLY_DIR}/secret.png`));
      plant("altchunk-svg.docx", nested(`file://${WEB_ONLY_DIR}/secret.svg`));
    }, 300_000);

    afterAll(async () => {
      await new Promise<void>((done) => server.close(() => done()));
      // The project's own throwaway spool volume, never a real stack's.
      await execFileAsync(
        "docker",
        [
          "compose",
          "-f",
          join(REPO_ROOT, "docker-compose.yml"),
          "-p",
          PROJECT,
          "down",
          "--volumes",
        ],
        { env: { ...process.env, PINCHY_VERSION: VERSION } }
      ).catch(() => {});
      // The converter ran as its own uid (998) and LibreOffice left its
      // profiles in this bind mount with modes the runner's own user cannot
      // enter. On Docker Desktop and OrbStack file ownership maps to the host
      // user and this never shows; on a Linux runner it does. So the contents
      // go first, as root, in the same image.
      await execFileAsync("docker", [
        "run",
        "--rm",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        "-v",
        `${root}:/canary`,
        IMAGE,
        "-c",
        "rm -rf /canary/* /canary/.[!.]*",
      ]).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    });

    it("CONTROL: on a bridge network the same image fetches every planted link — the canary can go red", async () => {
      expect((await bridged("node", ["-e", probe(hostIp, port)])).trim()).toBe("CONNECTED");
      drain();

      await bridged("soffice", stockConversion("control", inputs));

      const fetched = drain();
      for (const path of ["/linked-http.png", "/mislabelled.png", "/html.png"]) {
        expect(
          fetched.some((r) => r.endsWith(` ${path}`)),
          `${path} in [${fetched.join(", ")}]`
        ).toBe(true);
      }
    }, 300_000);

    it("CONTROL: where the web container's files exist, an altChunk file:// reference draws them into the PDF", async () => {
      // Stand-in for the web container: the same files at the same path.
      await bridged(
        "soffice",
        stockConversion("control-alt", ["altchunk-png.docx", "altchunk-svg.docx"]),
        [
          `${join(root, "secret.png")}:${WEB_ONLY_DIR}/secret.png:ro`,
          `${join(root, "secret.svg")}:${WEB_ONLY_DIR}/secret.svg:ro`,
        ]
      );

      // The picture is drawn in, and the SVG's text becomes searchable PDF text:
      // a file read, served to every reader of the knowledge base.
      expect(imagesIn(join(root, "control-alt-out", "altchunk-png.pdf"))).toBeGreaterThan(0);
      expect(await pdfText(join(root, "control-alt-out", "altchunk-svg.pdf"))).toContain(
        SECRET_TEXT
      );
    }, 300_000);

    it("BOUNDARY: as shipped, the same altChunk references find nothing to read", async () => {
      await asShipped(
        "soffice",
        stockConversion("boundary-alt", ["altchunk-png.docx", "altchunk-svg.docx"])
      );

      for (const name of ["altchunk-png", "altchunk-svg"]) {
        const pdf = join(root, "boundary-alt-out", `${name}.pdf`);
        const text = await pdfText(pdf);
        // Converted, nested chunk and all — the document is fine — but the
        // paths it points at do not exist in the converter.
        expect(text, name).toContain("Embedded chunk");
        expect(text, name).not.toContain(SECRET_TEXT);
        expect(imagesIn(pdf), name).toBe(0);
      }
    }, 300_000);

    it("BOUNDARY: as shipped, it converts the same files with the stock profile and nothing arrives", async () => {
      drain();
      await asShipped("soffice", stockConversion("boundary", inputs));

      expect(drain()).toEqual([]);
      // Not vacuous: LibreOffice really ran and really converted every file —
      // it was not refused, it simply had nowhere to send a request.
      const produced = readdirSync(join(root, "boundary-out")).sort();
      expect(produced).toEqual(inputs.map((i) => i.replace(/\.[^.]+$/, ".pdf")).sort());
      // The http-linked picture is not in the PDF: there was nothing to fetch it from.
      expect(imagesIn(join(root, "boundary-out", "linked-http.pdf"))).toBe(0);
    }, 300_000);

    it("BOUNDARY: a socket to the same address has no route, and lo is the only interface", async () => {
      expect((await asShipped("node", ["-e", probe(hostIp, port)])).trim()).toBe("ENETUNREACH");
      expect((await asShipped("ls", ["/sys/class/net"])).trim().split(/\s+/)).toEqual(["lo"]);
    }, 300_000);

    it("SECRETS: there is nothing for a file:// link to draw in", async () => {
      // The paths the web container mounts secrets, config and the corpus at.
      // In the converter they are either absent or the image's empty mountpoints.
      const files = await asShipped("sh", [
        "-c",
        "find /openclaw-config /openclaw-secrets /app/secrets /data /var/cache/pinchy-kb-artifacts -type f 2>/dev/null | wc -l",
      ]);
      expect(files.trim()).toBe("0");

      const env = await asShipped("env", []);
      for (const name of [
        "DATABASE_URL",
        "ENCRYPTION_KEY",
        "BETTER_AUTH_SECRET",
        "AUDIT_HMAC_SECRET",
        "PINCHY_ENTERPRISE_KEY",
      ]) {
        expect(env, name).not.toMatch(new RegExp(`^${name}=`, "m"));
      }
    }, 300_000);
  }
);
