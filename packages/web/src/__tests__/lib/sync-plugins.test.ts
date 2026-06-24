import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// config/sync-plugins.sh is the pinchy-container entrypoint's plugin-source
// sync, extracted so it is testable. CRITICAL invariant (regressed in PR #275):
// it must refresh plugin SOURCE in the shared openclaw-extensions volume WITHOUT
// wiping each plugin's node_modules. Those node_modules are installed by the
// OpenClaw container's start-openclaw.sh (install_plugin_deps) from baked
// /opt/<plugin>-deps bundles and are the ONLY copy — the pinchy image ships no
// node_modules. The old `rm -rf "$dst"; cp -r` wiped them, so a pinchy-only
// restart (deps not re-installed until openclaw restarts) broke pinchy-web /
// pinchy-files / pinchy-odoo at load time ("Cannot find module").

const REPO_ROOT = resolve(__dirname, "../../../../..");
const SCRIPT = resolve(REPO_ROOT, "config/sync-plugins.sh");

let root: string;
let srcRoot: string;
let dstRoot: string;

function runSync(): void {
  execFileSync("sh", [SCRIPT], {
    env: { ...process.env, PLUGIN_SRC_ROOT: srcRoot, PLUGIN_DST_ROOT: dstRoot },
    stdio: "pipe",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pinchy-sync-plugins-"));
  srcRoot = join(root, "image-src");
  dstRoot = join(root, "volume-dst");
  mkdirSync(srcRoot, { recursive: true });
  mkdirSync(dstRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sync-plugins.sh", () => {
  it("preserves an existing plugin's node_modules across a source re-sync", () => {
    // Image source (no node_modules — never shipped) with NEW source content.
    mkdirSync(join(srcRoot, "pinchy-web"), { recursive: true });
    writeFileSync(join(srcRoot, "pinchy-web", "index.ts"), "new source\n");

    // Volume already populated by a prior boot: openclaw-installed deps + stale
    // source that differs from the image.
    mkdirSync(join(dstRoot, "pinchy-web", "node_modules", "@mozilla", "readability"), {
      recursive: true,
    });
    writeFileSync(
      join(dstRoot, "pinchy-web", "node_modules", "@mozilla", "readability", "index.js"),
      "DEP MARKER\n"
    );
    writeFileSync(join(dstRoot, "pinchy-web", "index.ts"), "old source\n");
    writeFileSync(join(dstRoot, "pinchy-web", "stale-removed.ts"), "gone next sync\n");

    runSync();

    // The dependency the OpenClaw container installed MUST survive.
    expect(
      existsSync(join(dstRoot, "pinchy-web", "node_modules", "@mozilla", "readability", "index.js"))
    ).toBe(true);
    // Source is refreshed to the image version.
    expect(readFileSync(join(dstRoot, "pinchy-web", "index.ts"), "utf8")).toBe("new source\n");
    // Stale source the image no longer ships is removed.
    expect(existsSync(join(dstRoot, "pinchy-web", "stale-removed.ts"))).toBe(false);
  });

  it("creates a fresh plugin dir from source on first boot (empty volume)", () => {
    mkdirSync(join(srcRoot, "pinchy-context"), { recursive: true });
    writeFileSync(join(srcRoot, "pinchy-context", "index.ts"), "ctx\n");

    runSync();

    expect(readFileSync(join(dstRoot, "pinchy-context", "index.ts"), "utf8")).toBe("ctx\n");
  });

  it("does not re-sync (preserves node_modules) when source is unchanged", () => {
    mkdirSync(join(srcRoot, "pinchy-web"), { recursive: true });
    writeFileSync(join(srcRoot, "pinchy-web", "index.ts"), "same\n");
    mkdirSync(join(dstRoot, "pinchy-web", "node_modules"), { recursive: true });
    writeFileSync(join(dstRoot, "pinchy-web", "node_modules", "marker"), "keep\n");
    writeFileSync(join(dstRoot, "pinchy-web", "index.ts"), "same\n");

    runSync();

    expect(existsSync(join(dstRoot, "pinchy-web", "node_modules", "marker"))).toBe(true);
    expect(readFileSync(join(dstRoot, "pinchy-web", "index.ts"), "utf8")).toBe("same\n");
  });
});
