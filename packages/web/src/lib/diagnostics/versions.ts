// Read the three version strings included in every diagnostics bundle.
//
//   - `pinchy`       — injected at build time via NEXT_PUBLIC_PINCHY_VERSION.
//   - `openclaw`     — injected at build time via NEXT_PUBLIC_OPENCLAW_VERSION
//                       (the OC gateway version Pinchy is paired with).
//   - `openclawNode` — read from the openclaw-node npm package's own
//                       package.json. The package's `exports` map doesn't
//                       expose `./package.json`, so neither a static
//                       `import "openclaw-node/package.json"` nor
//                       `require("openclaw-node/package.json")` work. Instead
//                       we resolve the package's main entry and walk up to
//                       find the enclosing package.json — this never touches
//                       the exports map. If anything goes wrong (e.g. the
//                       package is unresolvable in a stripped image) we
//                       degrade to "unknown" rather than crashing the route.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function readOpenclawNodeVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const mainPath = require.resolve("openclaw-node");
    // Expected resolutions across our layouts:
    //   pnpm hoisted (root install): node_modules/openclaw-node/dist/index.js
    //     → ../package.json (1 level up)
    //   pnpm non-hoisted (default):  node_modules/.pnpm/openclaw-node@<v>/
    //                                 node_modules/openclaw-node/dist/index.js
    //     → ../package.json (1 level up — `.pnpm/<pkg>@<v>/node_modules/<pkg>/`
    //       still ends at the package root one level above main)
    // We tolerate up to 5 levels in case the package ever nests its main
    // file deeper (e.g. dist/cjs/index.js or dist/esm/node/index.js). On
    // any failure we degrade to "unknown" rather than crashing the route.
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
    return "unknown";
  } catch {
    return "unknown";
  }
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
