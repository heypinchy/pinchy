/**
 * Build script for pinchy-mcp.
 *
 * Bundles src/index.ts (+ its imports) into a single index.js at the plugin
 * root so OpenClaw can load it from the extensions directory without needing
 * a separate TypeScript transpiler in the container.
 *
 * Usage: node --import tsx/esm build.ts  (or: pnpm build)
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

await esbuild.build({
  entryPoints: [join(__dirname, "src", "index.ts")],
  outfile: join(__dirname, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // No external — credential-cache.ts is bundled in.
  // OpenClaw plugin runtime provides global fetch (Node 22 built-in).
  packages: "external", // keep any npm dependencies external (none currently)
  sourcemap: false,
  logLevel: "info",
});

console.log("pinchy-mcp: build complete → index.js");
