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
  /**
   * Where the converter must write `<index>.pdf` — or `<index>.xlsx` for a
   * batch of legacy workbooks (`convertTargetFor`).
   */
  outDir: string;
  /** A private LibreOffice profile, so concurrent runs never fight over one user installation. */
  profileDir: string;
  /**
   * The converter's scratch space (`TMPDIR`), inside the batch — on the volume
   * the free-space check asks, and removed with the batch.
   */
  tmpDir: string;
  timeoutMs: number;
}

export interface ConverterResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** True when WE killed it for taking too long — infrastructure, but not memory. */
  timedOut?: boolean;
  /**
   * True when the office-converter found a process of the run still running
   * after it (office-converter-sidecar.ts). Nothing of the run is trusted, the
   * converter restarts, and its documents are run one at a time, as after a
   * kill.
   */
  leftovers?: boolean;
}

export type RunConverter = (run: ConverterRun) => Promise<ConverterResult>;

/**
 * stderr we keep. LibreOffice repeats itself per file; a huge batch must not
 * build a huge string. But the per-file `impl_store … failed` line is what an
 * operator is shown for a PDF the full volume did not take (`failedStoreLine`
 * — the volume decides, the line only says what LibreOffice saw), so the cap
 * must hold a whole batch of them: at staging-path lengths a failed file
 * costs ~450 bytes (its `convert` line and its error), 20 of them ~9 KB.
 */
const MAX_STDERR_BYTES = 32 * 1024;

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

export function childEnv(home: string, tmpDir?: string): NodeJS.ProcessEnv {
  // NODE_ENV carries no secret and is what every child process here already
  // sees; it is listed explicitly because Next.js declares it non-optional.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, HOME: home };
  if (tmpDir !== undefined) env.TMPDIR = tmpDir;
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
 * Macros are pinned off as well: `MacroSecurityLevel = 3` (very high: only
 * macros from trusted file locations, and there are none) and
 * `DisableMacrosExecution = true` (disables Basic, Beanshell, JavaScript and
 * Python scripts outright; names and types as declared in officecfg
 * `Common.xcs`). Unlike the link settings these were NOT chosen by canary:
 * the shipped default is already level 2 (high, unsigned macros disabled), so
 * there is no behaviour to measure against. They are pinned so that a changed
 * default, or an override from a distro or a shared configuration, cannot
 * quietly turn macro execution on for untrusted documents.
 *
 * Two honest limits, both measured. This profile
 * does NOT stop LibreOffice's HTML import (an altChunk) or its SVG import from
 * reading `file://` references — and anything LibreOffice takes for SVG by its
 * bytes goes through that import, whatever the document called it: a picture,
 * a font, an RTF `\pict`, a picture inside an EMF+ record. For OOXML and RTF,
 * `office-preflight.ts` is a second layer — defence in depth with known
 * limits, not a guarantee: it cuts altChunks, pictures that reach outside
 * themselves (and every record of a metafile that can carry another) and
 * everything else not on its allow-list, and refuses what it cannot read
 * unambiguously. Each of those answers a vector found by canary; the next way
 * LibreOffice draws something by its bytes is a gap until it is found. For
 * the legacy binary formats (`.doc`, `.ppt`), which the preflight cannot
 * rewrite, this profile is the ONLY layer, and an SVG embedded in one still
 * reads a local file (the canary pins that gap).
 *
 * None of it is the boundary. In production this runs in the office-converter
 * sidecar, which has no network to fetch over and no secret or workspace to
 * read (office-converter-sidecar.ts) — that is what closes the family. These
 * settings still guard the in-process converter a developer machine runs,
 * which has both. The canaries say, vector by vector, which layers hold alone.
 *
 * The last setting is not about links: it pins LibreOffice's Temp path to
 * `$(temp)`, which is `TMPDIR` (see `runSoffice`). That is the default on
 * Linux, but a macOS build defaults to the profile's own `temp` directory
 * (measured, LibreOffice 26.2), so the scratch space would follow the build
 * rather than the batch's `tmpDir`.
 */
const LOCKED_DOWN_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${[
  ["/org.openoffice.Office.Common/Security/Scripting", "BlockUntrustedRefererLinks", "true"],
  ["/org.openoffice.Office.Common/Security/Scripting", "MacroSecurityLevel", "3"],
  ["/org.openoffice.Office.Common/Security/Scripting", "DisableMacrosExecution", "true"],
  ["/org.openoffice.Office.Writer/Content/Update", "Link", "2"],
  ["/org.openoffice.Inet/Settings", "ooInetProxyType", "2"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPProxyName", "127.0.0.1"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPProxyPort", "9"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPSProxyName", "127.0.0.1"],
  ["/org.openoffice.Inet/Settings", "ooInetHTTPSProxyPort", "9"],
  ["/org.openoffice.Inet/Settings", "ooInetNoProxy", ""],
  [
    "/org.openoffice.Office.Paths/Paths/org.openoffice.Office.Paths:NamedPath['Temp']",
    "WritePath",
    "$(temp)",
  ],
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
 * `TMPDIR` puts its scratch space there too. LibreOffice unpacks a package
 * into it while loading — about the unpacked size — and left to itself uses
 * the container's /tmp, a volume no check here looks at: a load that runs out
 * of room there exits 0 with `source file could not be loaded`, which is what
 * an unreadable document says. In the batch it is on the volume
 * `outputVolumeFault` asks. Verified against the runtime image's
 * LibreOffice 7.4: with a 20 MiB /tmp and TMPDIR on a roomy volume, a
 * document needing 26 MB of scratch converts and /tmp stays empty. LibreOffice
 * finds TMPDIR through its Temp path setting, which the profile pins.
 *
 * The binary is resolved per call rather than at import so a test can point at
 * a stub: without that, everything below is only reachable on a machine with a
 * 422 MB LibreOffice installed, which is no machine CI runs on.
 */
export const runSoffice: RunConverter = async (run) => {
  convertTargetFor(run.inputs);
  // Before the process exists, and a failure here is a failure to convert: a
  // converter that cannot be locked down must not run at all.
  await writeLockedDownProfile(run.profileDir);
  return spawnSoffice(run);
};

/**
 * What `--convert-to` asks for, read off the inputs' own extensions.
 *
 * A page-shaped document becomes a PDF. A legacy `.xls` becomes an `.xlsx`
 * through Calc's OOXML export filter (#1373): the spreadsheet reader parses
 * OOXML only, and a sheet rendered to pages would clip the very columns the
 * cell-based reader keeps. One process takes one target, so a batch that
 * mixes the two is refused rather than half of it converted into the wrong
 * thing — the caller groups by target.
 *
 * Derived here rather than passed in, so the sidecar's protocol carries
 * nothing new: it already names each input by its extension, and nothing a
 * request says can pick a filter the inputs did not.
 */
export function convertTargetFor(inputs: readonly string[]): string {
  const legacy = inputs.filter((input) => /\.xls$/i.test(input)).length;
  if (legacy === 0) return "pdf";
  if (legacy === inputs.length) return "xlsx:Calc MS Excel 2007 XML";
  throw new Error("a conversion batch must not mix legacy workbooks with other documents");
}

const spawnSoffice: RunConverter = ({ inputs, outDir, profileDir, tmpDir, timeoutMs }) =>
  new Promise<ConverterResult>((resolve, reject) => {
    const target = convertTargetFor(inputs);
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
        target,
        "--outdir",
        outDir,
        ...inputs,
      ],
      { stdio: ["ignore", "ignore", "pipe"], env: childEnv(profileDir, tmpDir), detached: true }
    );

    let stderr = "";
    let timedOut = false;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      // Sliced, not just checked: one pipe read can be 64 KB, and the cap is
      // what keeps the sidecar's answer inside what the web side reads.
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr = (stderr + chunk.toString("utf8")).slice(0, MAX_STDERR_BYTES);
      }
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
      // It finished on its own (or was killed): the budget no longer applies,
      // and must not fire while stderr drains and call a finished batch late.
      clearTimeout(timer);
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
