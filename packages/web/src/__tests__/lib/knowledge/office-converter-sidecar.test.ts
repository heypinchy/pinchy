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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  converterSocketPath,
  createOfficeConverterServer,
  listenOfficeConverter,
  sidecarConverter,
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

async function startServer(maxTimeoutMs?: number): Promise<void> {
  server = createOfficeConverterServer({
    spoolDir: spool,
    maxTimeoutMs,
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
  for (const name of names) await writeFile(join(inDir, name), "bytes");
  return {
    converter,
    dir,
    run: {
      inputs: names.map((n) => join(inDir, n)),
      outDir: join(dir, "out"),
      profileDir: join(dir, "profile"),
      timeoutMs: 5_000,
    } satisfies ConverterRun,
  };
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
    await startServer();
    answer = async () => {
      throw new Error("spawn soffice ENOENT");
    };
    const { converter, run } = await stagedBatch(["0.docx"]);

    await expect(converter.runConverter(run)).rejects.toThrow(/spawn soffice ENOENT/);
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
});
