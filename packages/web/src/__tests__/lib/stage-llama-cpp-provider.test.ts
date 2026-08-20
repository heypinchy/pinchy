import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";

// config/stage-llama-cpp-provider.sh is start-openclaw.sh's boot-time staging
// step for the bundled llama.cpp embedding provider, extracted into a sourceable
// helper (same pattern as config/install-plugin-deps.sh) for two reasons:
//   1. The staging contract becomes unit-testable here.
//   2. The offline CI smoke test (config/verify-memory-search.sh) SOURCES this
//      same file and calls the real function, instead of re-implementing the
//      copy inline — so a drift between the smoke test and the production boot
//      path can't hide.
//
// Contract: the built provider lives in /opt/llama-cpp-deps/npm (non-volume,
// baked into the image) because ~/.openclaw/npm is on the openclaw-config volume
// that shadows image-baked content on upgrade. On boot the function copies it
// into ~/.openclaw/npm if the provider isn't already there, then refreshes the
// registry. Paths are env-overridable so this test can drive it against temp dirs.
//
// The function shells out to `openclaw plugins registry --refresh`. We stub that
// binary on PATH so the refresh is deterministic and instant in EVERY
// environment: the real CLI may be absent, or present-and-slow, on a CI runner —
// exactly the non-determinism that timed this test out in CI. The stub's exit
// code also lets us exercise the warn-on-failure branch directly.
//
// `chown` is stubbed the same way, for a different reason: this suite runs
// unprivileged, so a real `chown root:root` always fails here and could never
// distinguish "the function asked" from "the function didn't". The stub records
// its argv instead. The REAL ownership assertion lives in
// config/verify-memory-search.sh, which runs as root inside the shipped image
// against a deliberately 999-owned tree — see the note there.

const REPO_ROOT = resolve(__dirname, "../../../../..");
const SCRIPT = resolve(REPO_ROOT, "config/stage-llama-cpp-provider.sh");

let root: string;
let depsRoot: string;
let npmRoot: string;
let binDir: string;
let chownLog: string;

// Install a stub `openclaw` on PATH whose `plugins registry --refresh` returns
// the given exit code (0 = refresh succeeds, non-zero = refresh fails).
function stubOpenclaw(exitCode: number): void {
  const bin = join(binDir, "openclaw");
  writeFileSync(bin, `#!/bin/bash\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
}

// Install a stub `chown` on PATH that appends its argv to chownLog and returns
// the given exit code (0 = chown succeeds, non-zero = chown fails).
function stubChown(exitCode: number): void {
  const bin = join(binDir, "chown");
  writeFileSync(bin, `#!/bin/bash\necho "$@" >> '${chownLog}'\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
}

function chownCalls(): string[] {
  if (!existsSync(chownLog)) return [];
  return readFileSync(chownLog, "utf8").split("\n").filter(Boolean);
}

function runStage(): string {
  return execFileSync("bash", ["-c", `source '${SCRIPT}'; stage_llama_cpp_provider`], {
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      LLAMA_CPP_DEPS_ROOT: depsRoot,
      OPENCLAW_NPM_ROOT: npmRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stage-llama-cpp-"));
  depsRoot = join(root, "opt", "llama-cpp-deps");
  npmRoot = join(root, "home", ".openclaw", "npm");
  binDir = join(root, "bin");
  chownLog = join(root, "chown.log");
  mkdirSync(binDir, { recursive: true });
  stubOpenclaw(0); // registry refresh succeeds by default
  stubChown(0); // chown succeeds by default
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("stage_llama_cpp_provider", () => {
  it("copies the bundled provider into the config-volume npm dir when absent", () => {
    // Simulate the image-baked provider tree under /opt.
    mkdirSync(join(depsRoot, "npm", "projects", "openclaw-llama-cpp-provider-abc123"), {
      recursive: true,
    });

    runStage();

    // Provider is now discoverable under ~/.openclaw/npm (where OpenClaw scans).
    expect(existsSync(join(npmRoot, "projects", "openclaw-llama-cpp-provider-abc123"))).toBe(true);
  });

  it("is idempotent — does not error when the provider is already staged", () => {
    mkdirSync(join(depsRoot, "npm", "projects", "openclaw-llama-cpp-provider-abc123"), {
      recursive: true,
    });
    // Provider already present in the config volume from a previous boot.
    mkdirSync(join(npmRoot, "projects", "openclaw-llama-cpp-provider-abc123"), {
      recursive: true,
    });

    expect(() => runStage()).not.toThrow();
    expect(existsSync(join(npmRoot, "projects", "openclaw-llama-cpp-provider-abc123"))).toBe(true);
  });

  it("is a safe no-op when the /opt bundle is missing (nothing to stage)", () => {
    // No depsRoot/npm — e.g. a build that didn't bundle the provider.
    expect(() => runStage()).not.toThrow();
    expect(existsSync(join(npmRoot, "projects"))).toBe(false);
  });

  it("warns but stays non-fatal when the registry refresh fails", () => {
    // A silent refresh failure means the provider never loads and recall
    // regresses to 0 chunks — so the function must WARN (not swallow with
    // `|| true`) yet keep booting (the file-read fallback still works).
    mkdirSync(join(depsRoot, "npm", "projects", "openclaw-llama-cpp-provider-abc123"), {
      recursive: true,
    });
    stubOpenclaw(1); // registry refresh fails

    let output = "";
    expect(() => {
      output = runStage();
    }).not.toThrow(); // non-fatal: boot continues
    expect(output).toMatch(/WARNING/);
    // Staging still happened despite the refresh failure.
    expect(existsSync(join(npmRoot, "projects", "openclaw-llama-cpp-provider-abc123"))).toBe(true);
  });

  // OpenClaw refuses to load a plugin whose files are not root-owned
  // ("blocked plugin candidate: suspicious ownership … uid=999, expected uid=0").
  // The openclaw-config volume is uid 999 nearly throughout — Pinchy shares it —
  // which is why start-openclaw.sh already force-chowns extensions/ to root. The
  // staged provider lives under npm/ and was missed, so on production it sat
  // blocked and every memory_search failed with "Unknown memory embedding
  // provider: local." (heypinchy/pinchy#1196).
  it("chowns the staged provider tree to root so OpenClaw does not block it", () => {
    mkdirSync(join(depsRoot, "npm", "projects", "openclaw-llama-cpp-provider-abc123"), {
      recursive: true,
    });

    runStage();

    expect(chownCalls()).toContainEqual(`-R root:root ${npmRoot}`);
  });

  // The production case, and the reason the chown must sit OUTSIDE the
  // "already staged?" guard: the copy runs at most once per volume, so a tree
  // staged by an earlier release is never rewritten. If ownership were only
  // repaired on the copy path, an upgraded deployment would stay blocked
  // forever — which is exactly what happened.
  it("repairs ownership even when the provider is already staged", () => {
    mkdirSync(join(depsRoot, "npm", "projects", "openclaw-llama-cpp-provider-abc123"), {
      recursive: true,
    });
    mkdirSync(join(npmRoot, "projects", "openclaw-llama-cpp-provider-abc123"), {
      recursive: true,
    });

    const output = runStage();

    // No copy this time…
    expect(output).not.toMatch(/staging bundled embedding provider/);
    // …but the ownership repair still ran.
    expect(chownCalls()).toContainEqual(`-R root:root ${npmRoot}`);
  });

  it("warns but stays non-fatal when the chown fails", () => {
    // Same contract as the registry refresh: a silent failure here means the
    // provider stays blocked and recall regresses to 0 chunks, so it must warn
    // — but boot continues, because the file-read fallback still works.
    mkdirSync(join(depsRoot, "npm", "projects", "openclaw-llama-cpp-provider-abc123"), {
      recursive: true,
    });
    stubChown(1);

    let output = "";
    expect(() => {
      output = runStage();
    }).not.toThrow();
    expect(output).toMatch(/WARNING/);
  });
});
