// Read the three version strings included in every diagnostics bundle.
//
//   - `pinchy`       — injected at build time via NEXT_PUBLIC_PINCHY_VERSION.
//   - `openclaw`     — injected at build time via NEXT_PUBLIC_OPENCLAW_VERSION
//                       (the OC gateway version Pinchy is paired with).
//   - `openclawNode` — read from the openclaw-node npm package's own
//                       package.json, via two strategies (see below). If both
//                       fail we degrade to "unknown" rather than crashing the
//                       route.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Strategy 1 (bundler-proof): read
 * `<baseDir>/node_modules/openclaw-node/package.json` directly off the
 * filesystem. `readFileSync` follows the pnpm symlink to the real package and
 * no bundler can interfere with a plain path read.
 *
 * This exists because strategy 2 silently broke in the production bundle:
 * webpack statically rewrites `require.resolve("openclaw-node")` when the
 * local is named `require`, returning a module id instead of a path —
 * `dirname()` threw, the catch swallowed it, and every bundle shipped
 * `openclawNodeVersion: "unknown"` (v0.5.7 staging finding). In all our
 * runtime layouts (dev compose, production image) the server's cwd is
 * `packages/web`, which has `node_modules/openclaw-node` — verified on
 * staging.
 *
 * Exported for tests. Returns null when the package.json is missing,
 * belongs to a different package, or has no usable version.
 */
export function readOpenclawNodeVersionFrom(baseDir: string): string | null {
  try {
    const raw = readFileSync(
      join(baseDir, "node_modules", "openclaw-node", "package.json"),
      "utf8"
    );
    const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown };
    if (pkg.name === "openclaw-node" && typeof pkg.version === "string" && pkg.version) {
      return pkg.version;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strategy 2 (fallback): resolve the package's main entry and walk up to the
 * enclosing package.json. The package's `exports` map doesn't expose
 * `./package.json`, so a direct `require("openclaw-node/package.json")` would
 * not work — the walk-up never touches the exports map.
 *
 * The createRequire local is deliberately NOT named `require`: webpack
 * special-cases the bare identifier `require` and statically rewrites
 * `require.resolve(...)`, which is exactly what broke this path in the
 * production bundle.
 */
function readOpenclawNodeVersionViaResolver(): string | null {
  try {
    const nodeRequire = createRequire(import.meta.url);
    const mainPath = nodeRequire.resolve("openclaw-node");
    if (typeof mainPath !== "string") return null;
    // Expected resolutions across our layouts:
    //   pnpm hoisted (root install): node_modules/openclaw-node/dist/index.js
    //     → ../package.json (1 level up)
    //   pnpm non-hoisted (default):  node_modules/.pnpm/openclaw-node@<v>/
    //                                 node_modules/openclaw-node/dist/index.js
    //     → ../package.json (1 level up)
    // We tolerate up to 5 levels in case the package ever nests its main
    // file deeper (e.g. dist/cjs/index.js).
    let dir = dirname(mainPath);
    for (let i = 0; i < 5; i++) {
      try {
        const raw = readFileSync(join(dir, "package.json"), "utf8");
        const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown };
        if (pkg.name === "openclaw-node" && typeof pkg.version === "string" && pkg.version) {
          return pkg.version;
        }
      } catch {
        // package.json not at this level — keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function readOpenclawNodeVersion(): string {
  return (
    readOpenclawNodeVersionFrom(process.cwd()) ?? readOpenclawNodeVersionViaResolver() ?? "unknown"
  );
}

export function getDiagnosticsVersions(): {
  pinchy: string;
  openclaw: string;
  openclawNode: string;
} {
  return {
    pinchy: process.env.NEXT_PUBLIC_PINCHY_VERSION ?? "unknown",
    openclaw: process.env.NEXT_PUBLIC_OPENCLAW_VERSION ?? "unknown",
    openclawNode: readOpenclawNodeVersion(),
  };
}
