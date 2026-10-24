import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";

// config/fix-volume-ownership.sh is the pinchy-container entrypoint's ownership
// repair for the shared `openclaw-config` volume, extracted into its own script
// (same pattern as config/sync-plugins.sh) so the one path it must NOT repair is
// unit-testable.
//
// THE INVARIANT THIS FILE EXISTS FOR (#1196):
//
//   /openclaw-config/npm must stay ROOT-owned, even though the rest of the
//   volume is handed to uid 999.
//
// That directory is OpenClaw's plugin store — it holds the bundled llama.cpp
// embedding provider — and OpenClaw's loader refuses a candidate whose files are
// not root-owned ("blocked plugin candidate: suspicious ownership … uid=999,
// expected uid=0 or root"). The entrypoint used to run a blanket
// `chown -R pinchy:pinchy /openclaw-config`, which swept npm/ up with everything
// else, so on production the provider sat blocked and every memory_search
// answered "Unknown memory embedding provider: local."
//
// The OpenClaw-side repair (config/stage-llama-cpp-provider.sh) runs at OpenClaw
// CONTAINER boot, and docker-compose.yml has `openclaw: depends_on: pinchy:
// service_healthy` — so a pinchy-only restart (an OOM under `mem_limit: 1g`, a
// redeploy, `restart: unless-stopped` after a crash) would re-break the tree
// with nothing left to repair it until the openclaw container itself restarts.
// Not chowning it in the first place is the durable half of the fix.
//
// `chown` is stubbed on PATH: a non-root test process cannot chown to uid 999,
// and the syscall itself is the kernel's business. Everything else runs for
// real — the real script, real `find` traversal, real prune, real gate, real
// chmod — so the assertions below are about what the script actually decides to
// do, not about a re-implementation of it.

const REPO_ROOT = resolve(__dirname, "../../../../..");
const SCRIPT = resolve(REPO_ROOT, "config/fix-volume-ownership.sh");
const ENTRYPOINT = readFileSync(resolve(REPO_ROOT, "entrypoint.sh"), "utf8");
// Comments stripped before the negative assertion below. entrypoint.sh QUOTES
// the removed command in the prose that explains why it is gone, and a text
// search that reads its own explanation as the thing it forbids reports on the
// presence of a string rather than on what the script does (same trap the
// image-copy guard hit in 1b5361f2b).
const ENTRYPOINT_CODE = ENTRYPOINT.split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

// A uid the temp fixtures are guaranteed NOT to be owned by, so the "skip what
// is already correct" gate doesn't swallow the assertions.
const FOREIGN_UID = "4242";

let root: string;
let configDir: string;
let binDir: string;
let chownLog: string;

function stubChown(): void {
  const bin = join(binDir, "chown");
  writeFileSync(bin, `#!/bin/bash\necho "$@" >> '${chownLog}'\nexit 0\n`);
  chmodSync(bin, 0o755);
}

function chownedPaths(): string {
  if (!existsSync(chownLog)) return "";
  return readFileSync(chownLog, "utf8");
}

function run(pinchyUid: string = FOREIGN_UID): string {
  return execFileSync("sh", [SCRIPT], {
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      OPENCLAW_CONFIG_DIR: configDir,
      PINCHY_UID: pinchyUid,
      PINCHY_GID: pinchyUid,
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pinchy-fix-volume-ownership-"));
  configDir = join(root, "openclaw-config");
  binDir = join(root, "bin");
  chownLog = join(root, "chown.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(configDir, "agents", "a1", "agent"), { recursive: true });
  mkdirSync(join(configDir, "npm", "projects", "openclaw-llama-cpp-provider-abc123"), {
    recursive: true,
  });
  writeFileSync(join(configDir, "openclaw.json"), "{}\n");
  writeFileSync(
    join(configDir, "npm", "projects", "openclaw-llama-cpp-provider-abc123", "package.json"),
    "{}\n"
  );
  stubChown();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("fix-volume-ownership.sh", () => {
  it("hands the config volume to the pinchy uid", () => {
    run();

    const chowned = chownedPaths();
    expect(chowned).toContain(join(configDir, "openclaw.json"));
    expect(chowned).toContain(join(configDir, "agents", "a1", "agent"));
    expect(chowned).toContain(`${FOREIGN_UID}:${FOREIGN_UID}`);
  });

  // The whole reason this script exists. OpenClaw blocks a plugin candidate it
  // does not see as root-owned, and npm/ is where the bundled embedding provider
  // lives — so handing it to uid 999 with the rest of the volume is what took
  // memory_search down on production (#1196).
  it("never chowns OpenClaw's plugin store", () => {
    run();

    expect(chownedPaths()).not.toContain(join(configDir, "npm"));
  });

  // The prune must not swallow the traversal: everything BESIDE npm/ still has
  // to be repaired, or the entrypoint stops doing the job it was written for.
  it("prunes only the plugin store, not its siblings", () => {
    mkdirSync(join(configDir, "credentials"), { recursive: true });
    writeFileSync(join(configDir, "credentials", "telegram-pairing.json"), "{}\n");

    run();

    expect(chownedPaths()).toContain(join(configDir, "credentials", "telegram-pairing.json"));
  });

  // `! -uid` gate: this volume carries agents/<id>/sessions and workspaces with
  // unbounded file counts, and chown rewrites ctime — which OpenClaw's
  // session-takeover detector reads as external modification. Same reasoning as
  // config/fix-config-permissions.sh, which gates every one of its chowns.
  it("leaves an already-correct tree alone", () => {
    const ownUid = String(process.getuid?.() ?? 0);

    run(ownUid);

    expect(chownedPaths()).toBe("");
  });

  // The Dockerfile's `mkdir -p` creates /openclaw-config as root:0755, but the
  // directory mode is not always 0755 in fresh CI volumes and uid 999 has to be
  // able to stat and enter it.
  it("makes the volume root itself traversable", () => {
    chmodSync(configDir, 0o700);

    run();

    expect(statSync(configDir).mode & 0o777).toBe(0o755);
  });
});

describe("entrypoint.sh volume-ownership wiring", () => {
  it("delegates the ownership repair to fix-volume-ownership.sh", () => {
    expect(ENTRYPOINT).toContain("/fix-volume-ownership.sh");
  });

  // The blanket form is the bug: it sweeps OpenClaw's plugin store up with the
  // rest of the volume on every pinchy boot (#1196).
  it("no longer chowns the whole volume unconditionally", () => {
    expect(ENTRYPOINT_CODE).not.toMatch(/chown\s+-R\s+pinchy:pinchy\s+\/openclaw-config\b/);
    // …and the guard must still see the command when it IS there, or it is
    // asserting nothing: the prose above the call quotes it verbatim.
    expect(ENTRYPOINT).toMatch(/chown\s+-R\s+pinchy:pinchy\s+\/openclaw-config\b/);
  });
});
