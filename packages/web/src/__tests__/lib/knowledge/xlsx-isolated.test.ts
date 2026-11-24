/**
 * The spreadsheet reader's child process.
 *
 * exceljs costs ~20× the sheet XML, so a workbook well inside the archive
 * limits could OOM-kill the 1 GB web container — on every nightly reindex,
 * and from the rows preview any member can request. These pin the fence:
 * the read happens in a heap-capped child, the parent gets the SAME answer
 * the in-process reader gives, and a child that runs out of heap reading a
 * file refuses that file instead of killing the server. Every other way a
 * child dies — killed without the heap banner, timed out, crashed, never
 * ready — is infrastructure, not a verdict, and must not be booked as one.
 * A preview whose requester went away stops costing the queue anything, and
 * the queue in front of the indexer is bounded.
 *
 * The death cases run stub children written into a temp dir, because a real
 * OOM, hang or crash on demand is exactly what a stub is for. The success and
 * the out-of-heap cases run the real child.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";

import { OfficeFileRejectedError } from "@/lib/knowledge/office-formats";
import { declaredBomb } from "@/test-helpers/office-zip";
import { buildMsg } from "@/test-helpers/msg-fixture";
import { parseMsg } from "@/lib/knowledge/msg-extract";
import { extractXlsx, readSheetRange, XlsxExtractionError } from "@/lib/knowledge/xlsx-extract";
import {
  checkSheetReaderQueue,
  extractXlsxIsolated,
  readMsgIsolated,
  readSheetRangeIsolated,
  runSheetReader,
  SHEET_READER_HEAP_MB,
  SheetReaderBusyError,
  SheetReaderCancelledError,
} from "@/lib/knowledge/xlsx-isolated";

const MiB = 1024 * 1024;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-xlsx-isolated-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function buildWorkbook(name: string, build: (wb: ExcelJS.Workbook) => void) {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  const path = join(tmpRoot, name);
  await workbook.xlsx.writeFile(path);
  return path;
}

/** A stub child: `body` runs inside an IPC-connected node, with `request` the parent's message. */
function stubChild(name: string, body: string): string {
  const path = join(tmpRoot, `${name}.mjs`);
  writeFileSync(path, body);
  return path;
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err as Error
  );

/** Is a process with this pid still alive? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the isolated reader answers exactly what the in-process reader answers", () => {
  it("extracts the same chunks, sheets and exclusions", async () => {
    const path = await buildWorkbook("same.xlsx", (wb) => {
      const products = wb.addWorksheet("Products");
      products.addRow(["Article", "Price"]);
      products.addRow(["A-1", 0.15]);
      products.getCell("B2").numFmt = "0%";
      products.addRow(["A-2", 3]);
      products.getRow(3).hidden = true;
      wb.addWorksheet("Secret").state = "hidden";
    });

    expect(await extractXlsxIsolated(path)).toEqual(await extractXlsx(path));
  });

  it("reads the same rows for a citation", async () => {
    const path = await buildWorkbook("rows.xlsx", (wb) => {
      const sheet = wb.addWorksheet("S");
      sheet.addRow(["Name", "City"]);
      for (let i = 0; i < 30; i++) sheet.addRow([`Person ${i}`, `City ${i}`]);
    });

    expect(await readSheetRangeIsolated(path, "S", 5, 9)).toEqual(
      await readSheetRange(path, "S", 5, 9)
    );
    expect(await readSheetRangeIsolated(path, "Nope", 1, 2)).toBeNull();
  });

  // An Outlook message is parsed behind the same fence (#1409): the parser
  // walks an untrusted Compound File and inflates RTF.
  it("reads an Outlook message, and refuses one that is not, across the boundary", async () => {
    const path = join(tmpRoot, "Angebot.msg");
    writeFileSync(
      path,
      buildMsg({ subject: "Angebot Größe 3", body: "Text", senderName: "Jörg Müller" })
    );
    expect(await readMsgIsolated(path)).toEqual(await parseMsg(path));

    const fake = join(tmpRoot, "fake.msg");
    writeFileSync(fake, "From: a@b\n\nplain mime");
    const refused = await rejection(readMsgIsolated(fake));
    expect(refused).toBeInstanceOf(OfficeFileRejectedError);
    expect((refused as OfficeFileRejectedError).code).toBe("unexpected_content");
  });

  it("carries the reader's own diagnoses across: unreadable stays unreadable, a refusal stays a refusal", async () => {
    const vanished = join(tmpRoot, "vanished.xlsx");
    const unreadable = await rejection(extractXlsxIsolated(vanished));
    expect(unreadable).toBeInstanceOf(XlsxExtractionError);
    expect(unreadable.message).toBe(
      `Cannot read spreadsheet ${vanished}: the file could not be opened as a workbook`
    );

    // Refused for its content: the same verdict on the file on this side of
    // the boundary, which the ingest lists as unsearchable rather than retries.
    const notAWorkbook = join(tmpRoot, "not.xlsx");
    await writeFile(notAWorkbook, "just text");
    const refused = await rejection(extractXlsxIsolated(notAWorkbook));
    expect(refused).toBeInstanceOf(OfficeFileRejectedError);
    expect((refused as OfficeFileRejectedError).code).toBe("unexpected_content");

    const bomb = join(tmpRoot, "bomb.xlsx");
    await writeFile(bomb, declaredBomb(1024 * MiB));
    const tooLarge = await rejection(readSheetRangeIsolated(bomb, null, 1, 5));
    expect(tooLarge).toBeInstanceOf(OfficeFileRejectedError);
    expect((tooLarge as OfficeFileRejectedError).code).toBe("too_large");
  });
});

describe("running out of heap is a verdict on the file", () => {
  it("runs out of heap: refused as too large, naming the heap limit", async () => {
    // The heap has to hold the reader itself (~18 MB loaded) with room to
    // spare, or the child dies LOADING — before it is ready, which is
    // rightly not a verdict on the file. A 16 MB cap sat on that edge and
    // flaked under load. So: 48 MB, and a 4 MiB sheet of
    // numbers whose model alone is several times that.
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("S").addRow([1]);
    const base = Buffer.from(await workbook.xlsx.writeBuffer());
    const head =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    const rows: string[] = [];
    let size = head.length;
    for (let r = 1; size < 4 * MiB; r++) {
      const row = `<row r="${r}">${"ABCDEFGHIJ"
        .split("")
        .map((c) => `<c r="${c}${r}"><v>${r}</v></c>`)
        .join("")}</row>`;
      rows.push(row);
      size += row.length;
    }
    const { replaceEntry } = await import("@/test-helpers/office-zip");
    const { deflatedPart } = await import("@/lib/knowledge/office-zip");
    const path = join(tmpRoot, "heavy.xlsx");
    await writeFile(
      path,
      replaceEntry(
        base,
        "xl/worksheets/sheet1.xml",
        deflatedPart(
          "xl/worksheets/sheet1.xml",
          Buffer.from(head + rows.join("") + "</sheetData></worksheet>")
        )
      )
    );

    const err = await rejection(extractXlsxIsolated(path, {}, { maxHeapMb: 48 }));
    expect(err).toBeInstanceOf(OfficeFileRejectedError);
    expect((err as OfficeFileRejectedError).code).toBe("too_large");
    expect(err.message).toContain("48 MB");
  }, 60_000);
});

describe("every other death is not a verdict on the file", () => {
  // V8's heap-limit banner is the one death that is about THIS file: the
  // heap cap was reached reading it. A SIGKILL without it is the container's
  // OOM killer, which `oom_score_adj` aims at the child whatever was using the
  // memory; a timeout can be a loaded host; a crash, a broken image. Booked
  // as a refusal, any of them became a permanent "unreadable" record — and on
  // a CHANGED file, ingest deleted the version it had indexed. A plain error
  // is counted `failed`, keeps the indexed version, and is read again.
  it("takes too long: killed, and a plain error that says so — never a refusal", async () => {
    const entry = stubChild(
      "hang",
      `process.send({ type: "ready" });
       process.on("message", () => setInterval(() => {}, 1000));`
    );
    const err = await rejection(
      runSheetReader({ op: "extract", path: "/x.xlsx" }, { entry, timeoutMs: 1500 })
    );
    expect(err).not.toBeInstanceOf(OfficeFileRejectedError);
    expect(err.message).toContain("longer than 1.5 s");
  });

  it("crashes mid-read: a plain error, never a refusal", async () => {
    const entry = stubChild(
      "crash",
      `process.send({ type: "ready" }); process.on("message", () => process.exit(3));`
    );
    const err = await rejection(runSheetReader({ op: "extract", path: "/x.xlsx" }, { entry }));
    expect(err).not.toBeInstanceOf(OfficeFileRejectedError);
    expect(err.message).toContain("exit code 3");
  });

  it("is killed from outside without the heap banner (the container's OOM killer): a plain error, never a refusal", async () => {
    const entry = stubChild(
      "killed",
      `process.send({ type: "ready" }); process.on("message", () => process.kill(process.pid, "SIGKILL"));`
    );
    const err = await rejection(runSheetReader({ op: "extract", path: "/x.xlsx" }, { entry }));
    expect(err).not.toBeInstanceOf(OfficeFileRejectedError);
    expect(err.message).toContain("killed");
  });
});

describe("a child that never got to read is infrastructure, not a verdict on the file", () => {
  it("dies before it is ready: a plain error, never a refusal", async () => {
    const entry = stubChild("broken", `throw new Error("cannot load the reader");`);
    const err = await rejection(runSheetReader({ op: "extract", path: "/x.xlsx" }, { entry }));
    expect(err).not.toBeInstanceOf(OfficeFileRejectedError);
    expect(err.message).toContain("before it was ready");
  });

  it("has no entry module at all: a plain error, never a refusal", async () => {
    const err = await rejection(
      runSheetReader(
        { op: "extract", path: "/x.xlsx" },
        { entry: join(tmpRoot, "does-not-exist.mjs") }
      )
    );
    expect(err).not.toBeInstanceOf(OfficeFileRejectedError);
  });
});

describe("the fence itself", () => {
  it("starts the child with the heap cap and without the server's secrets", async () => {
    const entry = stubChild(
      "inspect",
      `process.send({ type: "ready" });
       process.on("message", () =>
         process.send({ type: "result", value: { execArgv: process.execArgv, env: Object.keys(process.env) } })
       );`
    );
    process.env.PINCHY_TEST_SECRET_FOR_CHILD = "must-not-leak";
    try {
      const seen = (await runSheetReader({ op: "extract", path: "/x.xlsx" }, { entry })) as {
        execArgv: string[];
        env: string[];
      };
      expect(seen.execArgv).toContain(`--max-old-space-size=${SHEET_READER_HEAP_MB}`);
      expect(seen.env).not.toContain("PINCHY_TEST_SECRET_FOR_CHILD");
      expect(seen.env).not.toContain("DATABASE_URL");
    } finally {
      delete process.env.PINCHY_TEST_SECRET_FOR_CHILD;
    }
  });

  it("runs one child at a time, process-wide", async () => {
    const log = join(tmpRoot, "order.log");
    writeFileSync(log, "");
    const entry = stubChild(
      "slow",
      `import { appendFileSync } from "node:fs";
       process.send({ type: "ready" });
       process.on("message", (req) => {
         appendFileSync(req.path, "start\\n");
         setTimeout(() => { appendFileSync(req.path, "end\\n"); process.send({ type: "result", value: null }); }, 300);
       });`
    );
    await Promise.all([
      runSheetReader({ op: "extract", path: log }, { entry }),
      runSheetReader({ op: "extract", path: log }, { entry }),
      runSheetReader({ op: "extract", path: log }, { entry }),
    ]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "start",
      "end",
      "start",
      "end",
      "start",
      "end",
    ]);
  });

  it("leaves no child behind after a timeout", async () => {
    const pidFile = join(tmpRoot, "pid");
    const entry = stubChild(
      "hang-pid",
      `import { writeFileSync } from "node:fs";
       process.send({ type: "ready" });
       process.on("message", (req) => { writeFileSync(req.path, String(process.pid)); setInterval(() => {}, 1000); });`
    );
    await rejection(runSheetReader({ op: "extract", path: pidFile }, { entry, timeoutMs: 1000 }));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
  });
});

describe("a preview nobody waits for any more", () => {
  // Every rows preview queues behind the one reader child, and so does the
  // indexer. Without a way out, twenty reloads of a preview would queue twenty
  // reads of up to two minutes each — none of them wanted any more — in front
  // of the nightly reindex. A preview carries its request's signal; the indexer
  // carries none and is never cut short by somebody else's abort.

  /** A child that logs `start <path>` and answers after `ms`; the parent's request names the log in `path`. */
  function slowChild(ms: number) {
    return stubChild(
      `slow-${ms}`,
      `import { appendFileSync } from "node:fs";
       process.send({ type: "ready" });
       process.on("message", (req) => {
         appendFileSync(req.path, "start\\n");
         setTimeout(() => process.send({ type: "result", value: "done" }), ${ms});
       });`
    );
  }

  const starts = (log: string) => readFileSync(log, "utf8").split("\n").filter(Boolean).length;

  it("never starts a child for a request that was already gone", async () => {
    const log = join(tmpRoot, "order.log");
    writeFileSync(log, "");
    const err = await rejection(
      runSheetReader(
        { op: "extract", path: log },
        { entry: slowChild(10), signal: AbortSignal.abort() }
      )
    );
    expect(err).toBeInstanceOf(SheetReaderCancelledError);
    expect(starts(log)).toBe(0);
  });

  it("drops a queued read whose requester went away, without ever starting its child", async () => {
    const log = join(tmpRoot, "order.log");
    writeFileSync(log, "");
    const entry = slowChild(800);
    const holder = runSheetReader({ op: "extract", path: log }, { entry });
    const gone = new AbortController();
    const queued = rejection(
      runSheetReader({ op: "extract", path: log }, { entry, signal: gone.signal })
    );
    await expect.poll(() => starts(log)).toBe(1);

    const before = Date.now();
    gone.abort();
    expect(await queued).toBeInstanceOf(SheetReaderCancelledError);
    // Answered at once, not after the read in front of it.
    expect(Date.now() - before).toBeLessThan(500);
    expect(await holder).toBe("done");
    expect(starts(log)).toBe(1);
  });

  it("kills a running child whose requester went away, and hands the gate on", async () => {
    const pidFile = join(tmpRoot, "pid");
    const entry = stubChild(
      "hang-pid-abort",
      `import { writeFileSync } from "node:fs";
       process.send({ type: "ready" });
       process.on("message", (req) => { writeFileSync(req.path, String(process.pid)); setInterval(() => {}, 1000); });`
    );
    const gone = new AbortController();
    const running = rejection(
      runSheetReader({ op: "extract", path: pidFile }, { entry, signal: gone.signal })
    );
    await expect.poll(() => readFileSync(pidFile, { encoding: "utf8", flag: "a+" })).not.toBe("");
    const pid = Number(readFileSync(pidFile, "utf8"));

    gone.abort();
    expect(await running).toBeInstanceOf(SheetReaderCancelledError);
    await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);

    // The next read is not stuck behind the one that was cancelled.
    const log = join(tmpRoot, "after.log");
    writeFileSync(log, "");
    expect(await runSheetReader({ op: "extract", path: log }, { entry: slowChild(10) })).toBe(
      "done"
    );
  });

  it("leaves the indexer's read alone when a preview behind it goes away", async () => {
    const log = join(tmpRoot, "order.log");
    writeFileSync(log, "");
    const entry = slowChild(400);
    const indexer = runSheetReader({ op: "extract", path: log }, { entry });
    const gone = new AbortController();
    const preview = rejection(
      runSheetReader({ op: "extract", path: log }, { entry, signal: gone.signal })
    );
    await expect.poll(() => starts(log)).toBe(1);
    gone.abort();
    await preview;
    expect(await indexer).toBe("done");
  });

  it("refuses a preview past the queue limit at once, instead of queueing it", async () => {
    const log = join(tmpRoot, "order.log");
    writeFileSync(log, "");
    const entry = slowChild(600);
    const reads = [
      runSheetReader({ op: "extract", path: log }, { entry }),
      runSheetReader({ op: "extract", path: log }, { entry, maxQueued: 2 }),
      runSheetReader({ op: "extract", path: log }, { entry, maxQueued: 2 }),
    ];
    await expect.poll(() => starts(log)).toBe(1);

    const err = await rejection(
      runSheetReader({ op: "extract", path: log }, { entry, maxQueued: 2 })
    );
    expect(err).toBeInstanceOf(SheetReaderBusyError);
    // The indexer is never turned away: it names no limit.
    reads.push(runSheetReader({ op: "extract", path: log }, { entry }));
    expect(await Promise.all(reads)).toEqual(["done", "done", "done", "done"]);
  }, 20_000);

  it("answers whether a preview would be turned away, before it does any work of its own", async () => {
    // The rows route copies a workbook before it reads it. A preview the
    // queue will refuse must be refused before that copy, not after it.
    expect(() => checkSheetReaderQueue(2)).not.toThrow();
    const log = join(tmpRoot, "order.log");
    writeFileSync(log, "");
    const entry = slowChild(600);
    const reads = [
      runSheetReader({ op: "extract", path: log }, { entry }),
      runSheetReader({ op: "extract", path: log }, { entry, maxQueued: 2 }),
    ];
    await expect.poll(() => starts(log)).toBe(1);
    expect(() => checkSheetReaderQueue(2)).not.toThrow();

    reads.push(runSheetReader({ op: "extract", path: log }, { entry, maxQueued: 2 }));
    expect(() => checkSheetReaderQueue(2)).toThrow(SheetReaderBusyError);
    expect(await Promise.all(reads)).toEqual(["done", "done", "done"]);
    expect(() => checkSheetReaderQueue(2)).not.toThrow();
  }, 20_000);
});

describe("the parent's memory does not pay for the workbook (the rows route's bound)", () => {
  // Peak RSS is a per-PROCESS high-water mark, so it is only meaningful in a
  // process that did nothing else: each side runs in a fresh node. The
  // in-process control proves the workbook is heavy enough to show the
  // difference — without it, a flat parent could just mean a light file.
  const SHEET_XML_BYTES = 12 * MiB;

  function buildHeavyWorkbook(path: string) {
    const head =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    const rows: string[] = [];
    let size = head.length;
    for (let r = 1; size < SHEET_XML_BYTES; r++) {
      const row = `<row r="${r}">${"ABCDEFGHIJ"
        .split("")
        .map((c) => `<c r="${c}${r}"><v>${r}</v></c>`)
        .join("")}</row>`;
      rows.push(row);
      size += row.length;
    }
    return { head, body: rows.join(""), tail: "</sheetData></worksheet>", path };
  }

  function peakOf(script: string): number {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 120_000,
      }
    );
    const match = /PEAK (\d+)/.exec(result.stdout);
    if (!match) throw new Error(`no peak reported: ${result.stdout}\n${result.stderr}`);
    return Number(match[1]);
  }

  it("keeps the parent flat where the in-process read climbs by hundreds of MB", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("S").addRow([1]);
    const base = Buffer.from(await workbook.xlsx.writeBuffer());
    const { head, body, tail, path } = buildHeavyWorkbook(join(tmpRoot, "heavy.xlsx"));
    const { replaceEntry } = await import("@/test-helpers/office-zip");
    const { deflatedPart } = await import("@/lib/knowledge/office-zip");
    await writeFile(
      path,
      replaceEntry(
        base,
        "xl/worksheets/sheet1.xml",
        deflatedPart("xl/worksheets/sheet1.xml", Buffer.from(head + body + tail))
      )
    );

    const lib = join(process.cwd(), "src/lib/knowledge");
    const report = `console.log("PEAK", process.resourceUsage().maxRSS * 1024)`;
    const baseline = peakOf(
      `await import(${JSON.stringify(join(lib, "xlsx-extract.ts"))}); ${report}`
    );
    const inProcess = peakOf(
      `const m = await import(${JSON.stringify(join(lib, "xlsx-extract.ts"))});
       await m.readSheetRange(${JSON.stringify(path)}, "S", 1, 20); ${report}`
    );
    const isolated = peakOf(
      `const m = await import(${JSON.stringify(join(lib, "xlsx-isolated.ts"))});
       const r = await m.readSheetRangeIsolated(${JSON.stringify(path)}, "S", 1, 20);
       if (r.rows.length !== 20) throw new Error("wrong rows"); ${report}`
    );

    expect(inProcess - baseline).toBeGreaterThan(150 * MiB);
    expect(isolated - baseline).toBeLessThan(64 * MiB);
  }, 180_000);
});
