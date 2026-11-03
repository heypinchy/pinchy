/**
 * The office-converter sidecar's entrypoint, started the way docker-compose.yml
 * starts it: `node --import tsx src/server/office-converter.ts` from
 * packages/web, with the spool in `KB_OFFICE_SPOOL_DIR`.
 *
 * A unit test of the server module cannot see a broken entrypoint — a wrong
 * import, a top-level crash, a socket it never opens — and the first place
 * that would show is a production container restarting in a loop while every
 * Office document reads "not reachable". So this one runs the real process.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { sidecarConverter } from "@/lib/knowledge/office-converter-sidecar";

const WEB_ROOT = resolve(__dirname, "../../..");

let spool: string;
let child: ChildProcess | null;

beforeEach(() => {
  spool = mkdtempSync(join(tmpdir(), "kb-entry-"));
  child = null;
});

afterEach(() => {
  child?.kill("SIGKILL");
  rmSync(spool, { recursive: true, force: true });
});

function start(env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/server/office-converter.ts"], {
    cwd: WEB_ROOT,
    // Only what the service gets: docker-compose.yml passes no environment to
    // the converter, and the image provides PATH and KB_OFFICE_SPOOL_DIR.
    // NODE_ENV is listed because Next.js declares it non-optional on ProcessEnv.
    env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function health(): Promise<number> {
  return new Promise((resolvePromise) => {
    const req = request(
      { socketPath: join(spool, "converter.sock"), method: "GET", path: "/health" },
      (res) => {
        res.resume();
        resolvePromise(res.statusCode ?? 0);
      }
    );
    req.on("error", () => resolvePromise(0));
    req.end();
  });
}

describe("office-converter entrypoint", () => {
  it("listens on the spool's socket and answers a health probe", async () => {
    child = start({ KB_OFFICE_SPOOL_DIR: spool });
    let status = 0;
    const deadline = Date.now() + 15_000;
    while (status !== 200 && Date.now() < deadline) {
      status = await health();
      if (status !== 200) await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe(200);
  });

  it("refuses to start without a spool, and says which variable is missing", async () => {
    child = start({});
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const code = await new Promise<number | null>((r) => child!.on("close", r));

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/KB_OFFICE_SPOOL_DIR/);
  });

  it("removes its socket on SIGTERM, so the next start is clean", async () => {
    child = start({ KB_OFFICE_SPOOL_DIR: spool });
    const deadline = Date.now() + 15_000;
    while ((await health()) !== 200 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((r) => child!.on("close", r));

    expect(code).toBe(0);
    expect(await health()).toBe(0);
  });

  it("leaves what a conversion writes group-writable, so the web process can clean up after it", async () => {
    // The converter runs as its own uid, in the web process's group. A PDF it
    // writes with the default umask (022) could be read but not removed by
    // that group from a directory the converter created.
    const stub = join(spool, "soffice-stub.sh");
    writeFileSync(
      stub,
      `#!/bin/sh\nwhile [ "$1" != "--outdir" ]; do shift; done\nmkdir "$2/sub"\necho pdf > "$2/0.pdf"\n`
    );
    chmodSync(stub, 0o755);
    child = start({ KB_OFFICE_SPOOL_DIR: spool, KB_SOFFICE_BIN: stub });
    const deadline = Date.now() + 15_000;
    while ((await health()) !== 200 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const converter = sidecarConverter(spool);
    const dir = await converter.createStagingDir();
    await writeFile(join(dir, "in", "0.docx"), "bytes");
    const result = await converter.runConverter({
      inputs: [join(dir, "in", "0.docx")],
      outDir: join(dir, "out"),
      profileDir: join(dir, "profile"),
      timeoutMs: 10_000,
    });

    expect(result.code).toBe(0);
    expect(statSync(join(dir, "out", "0.pdf")).mode & 0o070).toBe(0o060);
    expect(statSync(join(dir, "out", "sub")).mode & 0o070).toBe(0o070);
  });
});
