import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

const REPO_ROOT = resolve(__dirname, "../../../../..");
const SCRIPT = resolve(REPO_ROOT, "config/stage-llama-cpp-provider.sh");

let root: string;
let depsRoot: string;
let npmRoot: string;

function runStage(): string {
  return execFileSync("bash", ["-c", `source '${SCRIPT}'; stage_llama_cpp_provider`], {
    env: { ...process.env, LLAMA_CPP_DEPS_ROOT: depsRoot, OPENCLAW_NPM_ROOT: npmRoot },
    stdio: "pipe",
    encoding: "utf8",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stage-llama-cpp-"));
  depsRoot = join(root, "opt", "llama-cpp-deps");
  npmRoot = join(root, "home", ".openclaw", "npm");
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
});
