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
 *   and no secret in the environment for a `file://` link to draw in.
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

import { docxWith, REL_HYPERLINK, REL_IMAGE, relationships } from "@/test-helpers/office-zip";

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
    async function bridged(entrypoint: string, args: string[]): Promise<string> {
      const { stdout } = await execFileAsync(
        "docker",
        [
          "run",
          "--rm",
          "--add-host",
          "canary-host:host-gateway",
          "-v",
          `${root}:/canary`,
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
      // The service runs as uid 999; the bind mount must be writable for it.
      chmodSync(root, 0o777);
      for (const dir of ["in", "control-out", "boundary-out"]) {
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
