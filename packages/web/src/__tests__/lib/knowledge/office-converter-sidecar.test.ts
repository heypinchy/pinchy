/**
 * The web ↔ office-converter protocol, both halves, over a REAL Unix socket.
 *
 * In production the two halves live in different containers: the web process
 * stages a batch in the shared spool and asks; the sidecar — no network, no
 * secrets — validates the request, derives every path itself and runs
 * `soffice`. Here both halves run in this process with the converter faked,
 * because what is under test is the protocol: what crosses the socket, what
 * the sidecar refuses, and how every way of NOT getting an answer becomes an
 * error (which office-convert books as `infrastructure`, retryable).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";

import {
  converterSocketPath,
  createOfficeConverterServer,
  leftoverProcesses,
  listenOfficeConverter,
  clearSpoolBatches,
  sidecarConverter,
  sweepSpool,
} from "@/lib/knowledge/office-converter-sidecar";
import type { ConverterResult, ConverterRun } from "@/lib/knowledge/office-soffice";

let spool: string;
let server: Server | null;
let seen: ConverterRun[];
let answer: (run: ConverterRun) => Promise<ConverterResult>;

beforeEach(() => {
  // Short on purpose: a Unix socket path is capped at ~104 bytes on macOS.
  spool = mkdtempSync(join(tmpdir(), "kb-spool-"));
  server = null;
  seen = [];
  answer = async () => ({ code: 0, signal: null, stderr: "", timedOut: false });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  rmSync(spool, { recursive: true, force: true });
});

async function startServer(
  maxTimeoutMs?: number,
  extra: {
    leftovers?: () => Promise<number[]>;
    onLeftovers?: (pids: number[]) => void;
  } = {}
): Promise<void> {
  server = createOfficeConverterServer({
    spoolDir: spool,
    maxTimeoutMs,
    ...extra,
    runConverter: async (run) => {
      seen.push(run);
      return answer(run);
    },
  });
  await listenOfficeConverter(server, spool);
}

/** A batch staged exactly the way office-convert stages one. */
async function stagedBatch(names: string[]) {
  const converter = sidecarConverter(spool);
  const dir = await converter.createStagingDir();
  const inDir = join(dir, "in");
  await mkdir(inDir, { recursive: true });
  await mkdir(join(dir, "out"), { recursive: true });
  await mkdir(join(dir, "profile"), { recursive: true });
  await mkdir(join(dir, "tmp"), { recursive: true });
  for (const name of names) await writeFile(join(inDir, name), "bytes");
  return {
    converter,
    dir,
    run: {
      inputs: names.map((n) => join(inDir, n)),
      outDir: join(dir, "out"),
      profileDir: join(dir, "profile"),
      tmpDir: join(dir, "tmp"),
      timeoutMs: 5_000,
    } satisfies ConverterRun,
  };
}

/** A socket nobody listens on, as a converter that exits without unlinking it leaves one. */
function leaveStaleSocket(): void {
  execFileSync(process.execPath, [
    "-e",
    `require("net").createServer().listen(${JSON.stringify(converterSocketPath(spool))}, () => process.exit(0))`,
  ]);
}

/** A raw request, for what the client would never send. */
function post(body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: converterSocketPath(spool), method: "POST", path: "/convert" },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("office-converter sidecar protocol", () => {
  it("runs the staged batch and hands the converter's result back unchanged", async () => {
    await startServer();
    answer = async () => ({ code: 0, signal: null, stderr: "converted 2", timedOut: false });
    const { converter, run } = await stagedBatch(["0.docx", "1.ppt"]);

    const result = await converter.runConverter(run);

    expect(result).toEqual({ code: 0, signal: null, stderr: "converted 2", timedOut: false });
    // The sidecar derived the same paths the web side staged — the spool is
    // mounted at one path in both containers, so nothing needs translating.
    expect(seen).toEqual([run]);
  });

  it("opens a fresh connection per batch instead of reusing a pooled one", async () => {
    // Batches are minutes apart. A pooled socket the sidecar's keep-alive has
    // just closed would fail the next batch as "socket hang up".
    await startServer();
    let connections = 0;
    server!.on("connection", () => connections++);
    const { converter, run } = await stagedBatch(["0.docx"]);

    await converter.runConverter(run);
    await converter.runConverter(run);

    expect(connections).toBe(2);
  });

  it("carries a SIGKILL across, so an out-of-memory kill stays retryable", async () => {
    await startServer();
    answer = async () => ({ code: null, signal: "SIGKILL", stderr: "", timedOut: false });
    const { converter, run } = await stagedBatch(["0.doc"]);

    expect(await converter.runConverter(run)).toEqual({
      code: null,
      signal: "SIGKILL",
      stderr: "",
      timedOut: false,
    });
  });

  it("takes a legacy workbook, which the converter turns into a workbook (#1373)", async () => {
    await startServer();
    const { converter, run } = await stagedBatch(["0.xls", "1.xls"]);

    expect((await converter.runConverter(run)).code).toBe(0);
    expect(seen).toEqual([run]);
  });

  it("carries a timeout across", async () => {
    await startServer();
    answer = async () => ({ code: null, signal: "SIGKILL", stderr: "", timedOut: true });
    const { converter, run } = await stagedBatch(["0.doc"]);

    expect((await converter.runConverter(run)).timedOut).toBe(true);
  });

  it("refuses, without asking, a run that was not staged in its spool", async () => {
    await startServer();
    const elsewhere = mkdtempSync(join(tmpdir(), "kb-elsewhere-"));
    try {
      const converter = sidecarConverter(spool);
      await expect(
        converter.runConverter({
          inputs: [join(elsewhere, "in", "0.docx")],
          outDir: join(elsewhere, "out"),
          profileDir: join(elsewhere, "profile"),
          tmpDir: join(elsewhere, "tmp"),
          timeoutMs: 5_000,
        })
      ).rejects.toThrow(/outside the office converter's spool/);
      expect(seen).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.each([
    ["a path instead of an index name", { inputs: ["../../../etc/passwd"] }],
    ["a name that is not an Office file", { inputs: ["0.html"] }],
    ["a workbook the reader opens without converting", { inputs: ["0.xlsx"] }],
    ["a nested name", { inputs: ["in/0.docx"] }],
    ["no inputs at all", { inputs: [] }],
    ["a batch that is not a staging id", { batch: "../profile" }],
    ["a timeout that is not a positive number", { timeoutMs: -1 }],
  ])("the sidecar refuses %s, and never runs the converter", async (_label, override) => {
    await startServer();
    const { dir } = await stagedBatch(["0.docx"]);
    const response = await post({
      batch: dir.split("/").pop(),
      inputs: ["0.docx"],
      timeoutMs: 5_000,
      ...override,
    });

    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("the sidecar refuses a body that is not JSON", async () => {
    await startServer();
    const response = await post("not json at all");
    // JSON.stringify of a string IS valid JSON, but not an object — still 400.
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("caps the time budget at the sidecar's own ceiling", async () => {
    await startServer(60_000);
    const { converter, run } = await stagedBatch(["0.docx"]);

    await converter.runConverter({ ...run, timeoutMs: 24 * 60 * 60 * 1000 });

    expect(seen[0].timeoutMs).toBe(60_000);
  });

  it("reports a converter that throws inside the sidecar as an error, not a result", async () => {
    // The answer says the converter could not run and where to look; the
    // error itself goes to the converter's own log, not over the socket.
    await startServer();
    answer = async () => {
      throw new Error("spawn soffice ENOENT");
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { converter, run } = await stagedBatch(["0.docx"]);

      const err = await converter.runConverter(run).catch((e: Error) => e);

      expect(String(err)).toMatch(/could not run.*docker compose logs office-converter/);
      expect(String(err)).not.toMatch(/ENOENT/);
      expect(logged.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/spawn soffice ENOENT/);
    } finally {
      logged.mockRestore();
    }
  });

  it("answers a request it cannot read with a fixed reason, never the error itself", async () => {
    await startServer();
    const big = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { socketPath: converterSocketPath(spool), method: "POST", path: "/convert" },
        (res) => {
          let text = "";
          res.on("data", (c: Buffer) => (text += c.toString("utf8")));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        }
      );
      req.on("error", reject);
      req.end("x".repeat(70 * 1024));
    });

    expect(big.status).toBe(400);
    expect(JSON.parse(big.body)).toEqual({ error: "the request could not be read" });
  });

  it("says where it looked and what to check when no sidecar is listening", async () => {
    // No server: the upgrade that kept an old docker-compose.yml. There is
    // deliberately no fallback to converting in-process — that fallback would
    // be the very capability the sidecar exists to remove.
    const { converter, run } = await stagedBatch(["0.docx"]);

    await expect(converter.runConverter(run)).rejects.toThrow(
      /office converter is not reachable at .*converter\.sock.*office-converter service/
    );
  });

  it("fails at once when there is no socket at all, without waiting for one", async () => {
    // No socket means no converter service — waiting would only slow every
    // batch of an install that kept its old docker-compose.yml.
    const converter = sidecarConverter(spool, { connectRetryMs: 10_000 });
    const { run } = await stagedBatch(["0.docx"]);
    const started = Date.now();

    await expect(converter.runConverter(run)).rejects.toThrow(/not reachable/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("waits for a converter that is restarting: its socket is there, nobody listens yet", async () => {
    // The converter exits to recycle itself and leaves its socket behind; the
    // next batch must not land in the gap and fail.
    leaveStaleSocket();
    const converter = sidecarConverter(spool, { connectRetryMs: 10_000, connectIntervalMs: 50 });
    const { run } = await stagedBatch(["0.docx"]);
    setTimeout(() => void startServer(), 300);

    await expect(converter.runConverter(run)).resolves.toMatchObject({ code: 0 });
  });

  it("says the converter is not answering, not that the compose file is old, when it never comes back", async () => {
    leaveStaleSocket();
    const converter = sidecarConverter(spool, { connectRetryMs: 200, connectIntervalMs: 50 });
    const { run } = await stagedBatch(["0.docx"]);

    const err = await converter.runConverter(run).catch((e: Error) => e);

    expect(String(err)).toMatch(
      /not answering .*converter\.sock.*docker compose logs office-converter/
    );
    expect(String(err)).not.toMatch(/docker-compose\.yml/);
  });

  it("says the converter went away when it closes the connection before answering", async () => {
    // A batch already in flight when the converter is stopped or restarted.
    server = createServer((req) => req.socket.destroy());
    await new Promise<void>((resolve) => server!.listen(converterSocketPath(spool), resolve));
    const { converter, run } = await stagedBatch(["0.docx"]);

    await expect(converter.runConverter(run)).rejects.toThrow(
      /office converter closed the connection before answering/
    );
  });

  it("never leaves the socket path missing while it replaces a leftover socket", async () => {
    // A web process retrying during a restart must find a socket that
    // refuses or one that answers — never none, which reads as "no converter
    // service" and is not retried.
    const path = converterSocketPath(spool);
    const servers: Server[] = [];
    servers.push(createOfficeConverterServer({ spoolDir: spool, runConverter: answer }));
    await listenOfficeConverter(servers[0], spool);
    const watcher = new Worker(
      `const { statSync } = require("node:fs");
       const { parentPort, workerData } = require("node:worker_threads");
       let missing = 0, stop = false;
       parentPort.on("message", () => { stop = true; });
       (function loop() {
         for (let i = 0; i < 2000; i++) {
           try { statSync(workerData); } catch { missing++; }
         }
         if (stop) parentPort.postMessage(missing); else setImmediate(loop);
       })();`,
      { eval: true, workerData: path }
    );
    try {
      await new Promise((r) => setTimeout(r, 50));
      for (let i = 0; i < 30; i++) {
        const next = createOfficeConverterServer({ spoolDir: spool, runConverter: answer });
        servers.push(next);
        await listenOfficeConverter(next, spool);
      }
      const missing = await new Promise<number>((resolve) => {
        watcher.once("message", resolve);
        watcher.postMessage("stop");
      });

      expect(missing).toBe(0);
      expect((await readdir(spool)).filter((e) => e.startsWith("converter"))).toEqual([
        "converter.sock",
      ]);
    } finally {
      await watcher.terminate();
      for (const s of servers) s.close();
    }
  });

  it("accepts a spool path written with a trailing slash", async () => {
    await startServer();
    const converter = sidecarConverter(`${spool}/`);
    const dir = await converter.createStagingDir();
    await writeFile(join(dir, "in", "0.docx"), "bytes");

    await expect(
      converter.runConverter({
        inputs: [join(dir, "in", "0.docx")],
        outDir: join(dir, "out"),
        profileDir: join(dir, "profile"),
        tmpDir: join(dir, "tmp"),
        timeoutMs: 5_000,
      })
    ).resolves.toMatchObject({ code: 0 });
  });

  it("after waiting out a converter once, tries the next batches once each instead of waiting again", async () => {
    // A stopped converter must cost a run one wait, not one per batch — and a
    // converter that comes back is used at once.
    leaveStaleSocket();
    const options = { connectRetryMs: 300, connectIntervalMs: 50 };
    const { run } = await stagedBatch(["0.docx"]);
    await expect(sidecarConverter(spool, options).runConverter(run)).rejects.toThrow(
      /not answering/
    );

    const started = Date.now();
    await expect(sidecarConverter(spool, options).runConverter(run)).rejects.toThrow(
      /not answering/
    );
    expect(Date.now() - started).toBeLessThan(150);

    await startServer();
    await expect(sidecarConverter(spool, options).runConverter(run)).resolves.toMatchObject({
      code: 0,
    });
  });

  it("does not wait out a stopped converter again later in a long run", async () => {
    leaveStaleSocket();
    const options = { connectRetryMs: 300, connectIntervalMs: 50 };
    const { run } = await stagedBatch(["0.docx"]);
    await expect(sidecarConverter(spool, options).runConverter(run)).rejects.toThrow(
      /not answering/
    );

    // Hours later in the same run, the converter still stopped.
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(now + 3 * 60 * 60 * 1000);
      const started = performance.now();
      await expect(sidecarConverter(spool, options).runConverter(run)).rejects.toThrow(
        /not answering/
      );
      expect(performance.now() - started).toBeLessThan(150);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is no longer given up on once the converter answers, even with an error", async () => {
    // An error is an answer: the converter is there. A later outage gets its
    // full wait again.
    leaveStaleSocket();
    const options = { connectRetryMs: 300, connectIntervalMs: 50 };
    const { run } = await stagedBatch(["0.docx"]);
    await expect(sidecarConverter(spool, options).runConverter(run)).rejects.toThrow(
      /not answering/
    );

    answer = async () => {
      throw new Error("soffice could not start");
    };
    await startServer();
    await expect(sidecarConverter(spool, options).runConverter(run)).rejects.toThrow(/refused/);
    // Closed, its socket stays behind and refuses — a converter gone again.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    const started = Date.now();
    await expect(sidecarConverter(spool, options).runConverter(run)).rejects.toThrow(
      /not answering/
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("connects only to a socket, never through a link in its place", async () => {
    // The converter owns its socket's entry in the spool and could replace it.
    const elsewhere = mkdtempSync(join(tmpdir(), "kb-else-"));
    const seenElsewhere: string[] = [];
    const decoy = createServer((req, res) => {
      seenElsewhere.push(req.url ?? "");
      res.end("{}");
    });
    try {
      await new Promise<void>((resolve) => decoy.listen(join(elsewhere, "s.sock"), resolve));
      await symlink(join(elsewhere, "s.sock"), converterSocketPath(spool));
      const { converter, run } = await stagedBatch(["0.docx"]);

      await expect(converter.runConverter(run)).rejects.toThrow(/is not a socket/);
      expect(seenElsewhere).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => decoy.close(() => resolve()));
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("gives up on a sidecar that never answers", async () => {
    await startServer();
    answer = () => new Promise<ConverterResult>(() => {});
    const converter = sidecarConverter(spool, { graceMs: 50 });
    const { run } = await stagedBatch(["0.docx"]);

    await expect(converter.runConverter({ ...run, timeoutMs: 50 })).rejects.toThrow(
      /did not answer/
    );
  });

  it("answers a health probe", async () => {
    await startServer();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { socketPath: converterSocketPath(spool), method: "GET", path: "/health" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it("replaces a socket file a crashed sidecar left behind", async () => {
    await writeFile(converterSocketPath(spool), "stale");
    await startServer();
    const { converter, run } = await stagedBatch(["0.docx"]);

    await expect(converter.runConverter(run)).resolves.toMatchObject({ code: 0 });
  });

  it("prunes batches a crashed web process left in the spool, and nothing else", async () => {
    await startServer();
    const converter = sidecarConverter(spool);
    const abandoned = await converter.createStagingDir();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(abandoned, twoDaysAgo, twoDaysAgo);
    const unrelated = join(spool, "not-a-batch");
    await mkdir(unrelated);
    await utimes(unrelated, twoDaysAgo, twoDaysAgo);

    const fresh = await converter.createStagingDir();

    const left = await readdir(spool);
    expect(left).not.toContain(abandoned.split("/").pop());
    expect(left).toContain(fresh.split("/").pop());
    expect(left).toContain("not-a-batch");
    expect(left).toContain("converter.sock");
    expect((await stat(fresh)).isDirectory()).toBe(true);
  });

  it("stages a batch the converter can read and write into, but not rearrange", async () => {
    // The converter runs as its own uid in the web process's group. It reads
    // in/, writes out/ and profile/, and the sticky bit keeps it from
    // renaming or removing anything there it did not create itself.
    const dir = await sidecarConverter(spool).createStagingDir();
    const mode = async (path: string) => (await stat(path)).mode & 0o7777;

    expect(await mode(dir)).toBe(0o750);
    expect(await mode(join(dir, "in"))).toBe(0o750);
    expect(await mode(join(dir, "out"))).toBe(0o1770);
    expect(await mode(join(dir, "profile"))).toBe(0o1770);
    expect(await mode(join(dir, "tmp"))).toBe(0o1770);
  });

  it("opens its socket to the web process's group and to nobody else", async () => {
    await startServer();
    expect((await stat(converterSocketPath(spool))).mode & 0o777).toBe(0o660);
  });

  it("clears the batch's profile after the run, so the web process can remove the batch", async () => {
    // LibreOffice fills the profile with directories of its own; one the web
    // process cannot enter would make it fail to clean up the batch.
    answer = async (run) => {
      await mkdir(join(run.profileDir, "user", "cache"), { recursive: true });
      await writeFile(join(run.profileDir, "user", "registrymodifications.xcu"), "x");
      await chmod(join(run.profileDir, "user"), 0o700);
      return { code: 0, signal: null, stderr: "", timedOut: false };
    };
    await startServer();
    const { converter, run } = await stagedBatch(["0.docx"]);

    await converter.runConverter(run);

    expect(await readdir(run.profileDir)).toEqual([]);
  });

  it("answers a batch that left processes running as such, and recycles itself", async () => {
    // A process that outlives its batch can still write into the batch the
    // web process is about to read, and into the next one. The answer says
    // so — the web side then runs the batch's documents one at a time, as
    // after a kill — and the container restarts.
    const recycled: number[][] = [];
    await startServer(undefined, {
      leftovers: async () => [4242],
      onLeftovers: (pids) => recycled.push(pids),
    });
    const { converter, run } = await stagedBatch(["0.docx"]);

    await expect(converter.runConverter(run)).resolves.toMatchObject({ leftovers: true });
    expect(recycled).toEqual([[4242]]);
  });

  it("does not recycle itself after a batch that left nothing behind", async () => {
    const recycled: number[][] = [];
    await startServer(undefined, {
      leftovers: async () => [],
      onLeftovers: (pids) => recycled.push(pids),
    });
    const { converter, run } = await stagedBatch(["0.docx"]);

    await expect(converter.runConverter(run)).resolves.toMatchObject({ code: 0 });
    expect(recycled).toEqual([]);
  });
});

describe("cleaning up a batch the converter wrote into", () => {
  it("removes what the web process staged and the converter's files, without descending into its directories", async () => {
    // The converter can create and rearrange directories in out/ and
    // profile/. The web process removes entries by name and never walks into
    // a directory it did not make.
    const converter = sidecarConverter(spool);
    const dir = await converter.createStagingDir();
    await writeFile(join(dir, "in", "0.docx"), "staged");
    await writeFile(join(dir, "out", "0.pdf"), "pdf");
    await mkdir(join(dir, "out", "sub"));
    await writeFile(join(dir, "out", "sub", "kept"), "x");

    await expect(converter.removeStagingDir(dir)).rejects.toThrow();

    expect(await readdir(join(dir, "out", "sub"))).toEqual(["kept"]);
    expect(await readdir(join(dir, "out"))).toEqual(["sub"]);
    await expect(stat(join(dir, "in"))).rejects.toThrow();
  });

  it("never goes through a part of the batch that is not its own directory", async () => {
    // Whatever stands at in/, out/, profile/ or tmp/ is only walked if it is
    // the real directory the web process made.
    const converter = sidecarConverter(spool);
    const dir = await converter.createStagingDir();
    const target = mkdtempSync(join(tmpdir(), "kb-target-"));
    try {
      await writeFile(join(target, "keep"), "x");
      await rm(join(dir, "in"), { recursive: true });
      await symlink(target, join(dir, "in"));

      await converter.removeStagingDir(dir).catch(() => {});

      expect(await readdir(target)).toEqual(["keep"]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("removes a batch completely when nothing of the converter's is left in it", async () => {
    const converter = sidecarConverter(spool);
    const dir = await converter.createStagingDir();
    await writeFile(join(dir, "in", "0.docx"), "staged");
    await writeFile(join(dir, "out", "0.pdf"), "pdf");

    await converter.removeStagingDir(dir);

    await expect(stat(dir)).rejects.toThrow();
  });

  it("prunes only stale batches the web process owns, and never through a link", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const mine = await sidecarConverter(spool).createStagingDir();
    await utimes(mine, twoDaysAgo, twoDaysAgo);
    const target = mkdtempSync(join(tmpdir(), "kb-target-"));
    try {
      await mkdir(join(target, "in"));
      await writeFile(join(target, "in", "keep"), "x");
      const link = join(spool, "11111111-2222-3333-4444-555555555555");
      await symlink(target, link);

      // Someone else's uid: the prune must leave the batch alone.
      await sidecarConverter(spool, { uid: 424242 }).createStagingDir();
      expect(await readdir(spool)).toContain(mine.split("/").pop());

      await sidecarConverter(spool).createStagingDir();
      const left = await readdir(spool);
      expect(left).not.toContain(mine.split("/").pop());
      expect(await readdir(join(target, "in"))).toEqual(["keep"]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("clears every batch of the web process's at boot, however fresh, and nothing else", async () => {
    // At boot no batch of ours is running: whatever is left belongs to an
    // interrupted run, and holds checked copies of documents.
    await startServer();
    const mine = await sidecarConverter(spool).createStagingDir();
    await writeFile(join(mine, "in", "0.docx"), "copy");
    const target = mkdtempSync(join(tmpdir(), "kb-target-"));
    try {
      await symlink(target, join(spool, "11111111-2222-3333-4444-555555555555"));
      await mkdir(join(spool, "not-a-batch"));

      expect(await clearSpoolBatches(spool, { uid: 424242 })).toBe(0);
      expect(await readdir(spool)).toContain(mine.split("/").pop());

      expect(await clearSpoolBatches(spool)).toBe(1);
      const left = await readdir(spool);
      expect(left).not.toContain(mine.split("/").pop());
      expect(left).toEqual(
        expect.arrayContaining([
          "converter.sock",
          "not-a-batch",
          "11111111-2222-3333-4444-555555555555",
        ])
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("the converter empties every batch's profile when it starts, and leaves the rest", async () => {
    // A converter that died mid-batch leaves its profile behind, made of
    // directories only it may remove.
    const dir = await sidecarConverter(spool).createStagingDir();
    await mkdir(join(dir, "profile", "user", "cache"), { recursive: true });
    await writeFile(join(dir, "out", "0.pdf"), "pdf");
    await mkdir(join(spool, "not-a-batch"));

    await sweepSpool(spool);

    expect(await readdir(join(dir, "profile"))).toEqual([]);
    expect(await readdir(join(dir, "out"))).toEqual(["0.pdf"]);
    expect(await readdir(spool)).toContain("not-a-batch");
  });
});

describe("what the web process accepts from the converter", () => {
  it("refuses an answer larger than any result", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ code: 0, signal: null, stderr: "x".repeat(300_000), timedOut: false })
      );
    });
    await new Promise<void>((resolve) => server!.listen(converterSocketPath(spool), resolve));
    const { converter, run } = await stagedBatch(["0.docx"]);

    await expect(converter.runConverter(run)).rejects.toThrow(/too large/);
  });

  it("recycles the converter after a batch with leftovers even when the web process has gone", async () => {
    const recycled: number[][] = [];
    await startServer(undefined, {
      leftovers: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return [4242];
      },
      onLeftovers: (pids) => recycled.push(pids),
    });
    const { run } = await stagedBatch(["0.docx"]);
    const batch = run.outDir.split("/").at(-2);

    const req = request({
      socketPath: converterSocketPath(spool),
      method: "POST",
      path: "/convert",
    });
    req.on("error", () => {});
    req.end(JSON.stringify({ batch, inputs: ["0.docx"], timeoutMs: 5_000 }));
    await new Promise((r) => setTimeout(r, 50));
    req.destroy();

    const deadline = Date.now() + 5_000;
    while (recycled.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(recycled).toEqual([[4242]]);
  });
});

describe("leftoverProcesses", () => {
  let proc: string;

  beforeEach(async () => {
    proc = mkdtempSync(join(tmpdir(), "kb-proc-"));
  });

  afterEach(() => {
    rmSync(proc, { recursive: true, force: true });
  });

  /** One /proc/<pid>/stat line: `pid (comm) state ppid …`. */
  async function processEntry(pid: number, comm: string, state: string, ppid: number) {
    await mkdir(join(proc, String(pid)));
    await writeFile(
      join(proc, String(pid), "stat"),
      `${pid} (${comm}) ${state} ${ppid} 1 1 0 -1\n`
    );
  }

  it("names the orphans handed to the init, not the server, its children or a `docker exec`", async () => {
    await processEntry(1, "docker-init", "S", 0);
    await processEntry(7, "node", "S", 1); // the server itself
    await processEntry(14, "esbuild", "S", 7); // tsx's, alive as long as the server
    await processEntry(40, "soffice.bin) (x", "S", 1); // an orphan, with a hostile name
    await processEntry(41, "oosplash", "S", 40); // its child: the orphan is the one to name
    await processEntry(60, "node", "S", 0); // a healthcheck, started by `docker exec`
    await processEntry(61, "sh", "S", 60);
    await processEntry(70, "soffice.bin", "Z", 1); // dead, waiting for the init to reap it
    await mkdir(join(proc, "self"));

    expect(await leftoverProcesses({ procDir: proc, self: 7, graceMs: 0 })).toEqual([40]);
  });

  it("waits a moment for a process that is on its way out", async () => {
    await processEntry(1, "docker-init", "S", 0);
    await processEntry(40, "soffice.bin", "S", 1);
    setTimeout(() => void rm(join(proc, "40"), { recursive: true, force: true }), 50);

    expect(
      await leftoverProcesses({ procDir: proc, self: 7, graceMs: 2_000, intervalMs: 20 })
    ).toEqual([]);
  });

  it("finds nothing where there is no /proc to read", async () => {
    expect(await leftoverProcesses({ procDir: join(proc, "missing"), self: 7 })).toEqual([]);
  });
});
