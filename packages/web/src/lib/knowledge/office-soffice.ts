/**
 * The one process in the knowledge base that opens an Office file with
 * LibreOffice: how `soffice` is spawned, what it inherits, what profile it runs
 * with, and what a timeout kills.
 *
 * Its own module, importing nothing but Node built-ins, because it runs in TWO
 * places. In production it runs inside the `office-converter` sidecar
 * (src/server/office-converter.ts) — a container with no network and no
 * secrets — and nowhere else; the web process only stages files and asks
 * (./office-converter-sidecar.ts). On a developer machine, and in the tests,
 * the web process calls it directly. The sidecar must not drag pdfjs, the
 * preflight or the artifact store in behind it, so none of them live here.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ConverterRun {
  /** Absolute paths of the staged inputs, in order. Their basenames are `<index>.<ext>`. */
  inputs: string[];
  /** Where the converter must write `<index>.pdf`. */
  outDir: string;
  /** A private LibreOffice profile, so concurrent runs never fight over one user installation. */
  profileDir: string;
  timeoutMs: number;
}

export interface ConverterResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** True when WE killed it for taking too long — infrastructure, but not memory. */
  timedOut?: boolean;
}

export type RunConverter = (run: ConverterRun) => Promise<ConverterResult>;

/** stderr we keep. LibreOffice repeats itself per file; a huge batch must not build a huge string. */
const MAX_STDERR_BYTES = 8 * 1024;

/**
 * How long, once the converter has exited, we still wait for its stderr to
 * close. Anything it started inherits the pipe and holds it open; without a
 * bound, such a process would keep the batch from ever answering.
 */
const STDERR_DRAIN_MS = 2_000;

/**
 * What a converter subprocess inherits from us — an allow-list, not a copy of
 * `process.env`.
 *
 * Both subprocesses in this module parse documents the corpus owner did not
 * write, in formats (legacy `.doc`/`.ppt`) with a long history of
 * memory-safety bugs. Neither has any use for `DATABASE_URL`,
 * `ENCRYPTION_KEY` or `BETTER_AUTH_SECRET`, so neither gets them. Verified
 * against the real binary: `PATH` plus `HOME` is enough to convert, with the
 * Central/Eastern European diacritics the corpus is full of intact; the rest
 * are locale and timezone, which change how a document RENDERS and so are
 * passed through when the operator set them.
 */
const INHERITED_ENV = ["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ"] as const;

export function childEnv(home: string): NodeJS.ProcessEnv {
  // NODE_ENV carries no secret and is what every child process here already
  // sees; it is listed explicitly because Next.js declares it non-optional.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, HOME: home };
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * SIGKILLs a child AND everything it forked.
 *
 * `spawn` is given `detached: true` so the child leads its own process group,
 * and this kills the group. That is not belt-and-braces: `soffice` execs
 * `oosplash`, which **forks** `soffice.bin` — so killing the process we
 * spawned leaves the real converter running, still holding the memory the
 * timeout was meant to reclaim and still writing into a staging directory we
 * are about to delete. Verified in the runtime image, both directions: killing
 * the pid orphans `soffice.bin`, killing the group reaps it.
 */
export function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already gone, or the platform has no process groups.
    child.kill("SIGKILL");
  }
}

/**
 * The user-installation settings every conversion runs with, written as
 * `registrymodifications.xcu` into a profile that has never been used.
 *
 * The documents are untrusted, and LibreOffice, left to its defaults, will
 * fetch a linked picture over HTTP (an SSRF from a container that has a
 * network) and embed a `file://` one into the PDF (a local-file read that is
 * then served to every reader of the knowledge base). Each setting here was
 * chosen by CANARY — a crafted document, a local listener, the real binary —
 * not by its name (office-convert.canary.libreoffice.test.ts keeps those canaries):
 *
 *   - `BlockUntrustedRefererLinks` stopped BOTH the http fetch and the
 *     `file://` embed on its own, for Word, PowerPoint, an HTML file posing as
 *     `.doc`, and flat ODF. It is the load-bearing line.
 *   - `Link = 2` (never update links on load) is the same intent, by the
 *     documented knob; on its own it did NOT stop the fetch.
 *   - A manual proxy at a closed port (nothing exempted) stopped the http
 *     fetch but not `file://`. Its job is the future: whatever LibreOffice
 *     learns to fetch next still has nowhere to go.
 *
 * Two honest limits, both measured (release reviews of v0.10.0). This profile
 * does NOT stop LibreOffice's HTML import (an altChunk) or its SVG import from
 * reading `file://` references — and anything LibreOffice takes for SVG by its
 * bytes goes through that import, whatever the document called it: a picture,
 * a font, an RTF `\pict`, a picture inside an EMF+ record. For OOXML and RTF,
 * `office-preflight.ts` is a second layer — defence in depth with known
 * limits, not a guarantee: it cuts altChunks, pictures that reach outside
 * themselves (metafiles carrying a picture of their own included) and
 * everything else not on its allow-list, and refuses what it cannot read
 * unambiguously. Each of those answers a vector a review found; the next way
 * LibreOffice draws something by its bytes is a gap until it is found. For
 * the legacy binary formats (`.doc`, `.ppt`), which the preflight cannot
 * rewrite, this profile is the ONLY layer of the two, and an SVG embedded in
 * one still reads a local file (the canary pins that gap).
 *
 * None of it is the boundary. In production this runs in the office-converter
 * sidecar, which has no network to fetch over and no secret or workspace to
 * read (office-converter-sidecar.ts) — that is what closes the family. These
 * settings still guard the in-process converter a developer machine runs,
 * which has both. The canaries say, vector by vector, which layers hold alone.
 */
const LOCKED_DOWN_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${[
  ["/org.openoffice.Office.Common/Security/Scripting", "BlockUntrustedRefererLinks", "true"],
  ["/org.openoffice.Office.Writer/Content/Update", "Link", "2"],
  ["/org.openoffice.Inet/Settings", "ooInetProxyType", "2"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPProxyName", "127.0.0.1"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPProxyPort", "9"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPSProxyName", "127.0.0.1"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPSProxyPort", "9"],
  ["/org.openoffice.Inet/Settings", "ooInetNoProxy", ""],
]
  .map(
    ([path, name, value]) =>
      `<item oor:path="${path}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`
  )
  .join("\n")}
</oor:items>
`;

async function writeLockedDownProfile(profileDir: string): Promise<void> {
  const userDir = join(profileDir, "user");
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, "registrymodifications.xcu"), LOCKED_DOWN_PROFILE);
}

/**
 * The real converter: ONE `soffice` per batch.
 *
 * `-env:UserInstallation` (and a matching HOME) gives the process a private
 * profile inside the staging directory. Without it LibreOffice shares one user
 * installation, and a second instance — a concurrent reindex, or a leftover
 * process — refuses to start or silently reuses the other's state.
 *
 * The binary is resolved per call rather than at import so a test can point at
 * a stub: without that, everything below is only reachable on a machine with a
 * 422 MB LibreOffice installed, which is no machine CI runs on.
 */
export const runSoffice: RunConverter = async ({ inputs, outDir, profileDir, timeoutMs }) => {
  // Before the process exists, and a failure here is a failure to convert: a
  // converter that cannot be locked down must not run at all.
  await writeLockedDownProfile(profileDir);
  return spawnSoffice({ inputs, outDir, profileDir, timeoutMs });
};

const spawnSoffice: RunConverter = ({ inputs, outDir, profileDir, timeoutMs }) =>
  new Promise<ConverterResult>((resolve, reject) => {
    const child = spawn(
      process.env.KB_SOFFICE_BIN || "soffice",
      [
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        "--nofirststartwizard",
        `-env:UserInstallation=file://${profileDir}`,
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        ...inputs,
      ],
      { stdio: ["ignore", "ignore", "pipe"], env: childEnv(profileDir), detached: true }
    );

    let stderr = "";
    let timedOut = false;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      resolve({ code, signal, stderr, timedOut });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      drain = setTimeout(() => {
        // Still held open: by something left in the converter's group, which
        // goes with it, or by something that left the group, which the
        // sidecar's leftover check finds next.
        killTree(child);
        child.stderr.destroy();
        finish(code, signal);
      }, STDERR_DRAIN_MS);
    });
    child.on("close", finish);
  });
