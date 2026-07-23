import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// config/install-plugin-deps.sh is start-openclaw.sh's plugin runtime-deps
// installer, extracted so it is testable (same pattern as
// config/sync-plugins.sh / sync-plugins.test.ts). CRITICAL invariant: in dev,
// docker-compose.dev.yml mounts a named shadow volume directly ON the target
// node_modules path to stop the host/container dependency ping-pong (host
// pnpm symlink farm vs. container-only deps). A named-volume mount is a real
// mountpoint inside the container — `rm -rf` on a mountpoint fails with
// "Device or resource busy" because you cannot remove the mounted directory
// itself, only empty its contents. The script must therefore replace the
// target's CONTENTS in place (assert the directory's inode is unchanged
// before/after, which is what a real mountpoint would require) rather than
// deleting and recreating the directory.

const REPO_ROOT = resolve(__dirname, "../../../../..");
const SCRIPT = resolve(REPO_ROOT, "config/install-plugin-deps.sh");

let root: string;
let extensionsRoot: string;
let depsRoot: string;

function runInstall(): void {
  execFileSync("bash", [SCRIPT], {
    env: { ...process.env, PLUGIN_EXTENSIONS_ROOT: extensionsRoot, PLUGIN_DEPS_ROOT: depsRoot },
    stdio: "pipe",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pinchy-install-plugin-deps-"));
  extensionsRoot = join(root, "extensions");
  depsRoot = join(root, "opt");
  mkdirSync(extensionsRoot, { recursive: true });
  mkdirSync(depsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("install-plugin-deps.sh", () => {
  it("replaces an existing node_modules' contents WITHOUT removing the directory itself (mountpoint-safe)", () => {
    // Bundle baked into the image at build time.
    mkdirSync(join(depsRoot, "pinchy-files-deps", "node_modules", "pdfjs-dist"), {
      recursive: true,
    });
    writeFileSync(
      join(depsRoot, "pinchy-files-deps", "node_modules", "pdfjs-dist", "index.js"),
      "bundle content\n"
    );

    // Target already exists with foreign content — simulates either a stale
    // prior install OR (in dev) a named-volume mountpoint whose directory
    // inode must never be replaced.
    const pluginDir = join(extensionsRoot, "pinchy-files");
    const targetNodeModules = join(pluginDir, "node_modules");
    mkdirSync(join(targetNodeModules, "stale-package"), { recursive: true });
    writeFileSync(join(targetNodeModules, "stale-package", "old.js"), "old\n");

    const inodeBefore = statSync(targetNodeModules).ino;

    runInstall();

    const inodeAfter = statSync(targetNodeModules).ino;
    // The directory itself must be the SAME inode — proves the script never
    // did `rm -rf` + recreate on the target, which would fail with "Device or
    // resource busy" on a real mountpoint.
    expect(inodeAfter).toBe(inodeBefore);

    // Foreign/stale content is gone.
    expect(existsSync(join(targetNodeModules, "stale-package"))).toBe(false);
    // Bundle content replaced it.
    expect(readFileSync(join(targetNodeModules, "pdfjs-dist", "index.js"), "utf8")).toBe(
      "bundle content\n"
    );
  });

  it("creates node_modules from the bundle when the target doesn't exist yet", () => {
    mkdirSync(join(depsRoot, "pinchy-odoo-deps", "node_modules", "odoo-node"), { recursive: true });
    writeFileSync(
      join(depsRoot, "pinchy-odoo-deps", "node_modules", "odoo-node", "index.js"),
      "odoo dep\n"
    );
    mkdirSync(join(extensionsRoot, "pinchy-odoo"), { recursive: true });

    runInstall();

    expect(
      readFileSync(
        join(extensionsRoot, "pinchy-odoo", "node_modules", "odoo-node", "index.js"),
        "utf8"
      )
    ).toBe("odoo dep\n");
  });

  it("no-ops without error when the /opt bundle is missing", () => {
    // No pinchy-web-deps bundle created at all.
    mkdirSync(join(extensionsRoot, "pinchy-web"), { recursive: true });

    expect(() => runInstall()).not.toThrow();
    expect(existsSync(join(extensionsRoot, "pinchy-web", "node_modules"))).toBe(false);
  });

  it("no-ops for a plugin whose extension directory isn't mounted", () => {
    // Bundle exists but the plugin's extension dir was never created —
    // e.g. plugin not enabled/mounted in this environment.
    mkdirSync(join(depsRoot, "pinchy-email-deps", "node_modules"), { recursive: true });
    writeFileSync(join(depsRoot, "pinchy-email-deps", "node_modules", "marker"), "x\n");

    expect(() => runInstall()).not.toThrow();
    expect(existsSync(join(extensionsRoot, "pinchy-email"))).toBe(false);
  });
});
