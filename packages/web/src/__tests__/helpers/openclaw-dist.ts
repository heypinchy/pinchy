import { vi } from "vitest";

/**
 * Load one named export from OpenClaw's installed dist. Chunk file names carry
 * a content hash and exports are minified (`resolveSkillWorkshopConfig as t`),
 * so the chunk is found by file-name prefix AND by the named export it
 * declares. Exactly one chunk must match: zero means OpenClaw renamed or moved
 * the function, two means this loader can no longer tell which one runs —
 * either way the contract has to be re-verified against the installed version.
 *
 * Reads the dist through the real `fs`, so it works from test files that mock
 * `fs` for the config write.
 */
export async function loadOpenClawDistExport(chunkPattern: RegExp, name: string): Promise<unknown> {
  const { createRequire } = await import("module");
  const { pathToFileURL } = await import("url");
  const pathMod = await import("path");
  const fsActual = await vi.importActual<typeof import("fs")>("fs");
  const require = createRequire(import.meta.url);
  const dist = pathMod.dirname(require.resolve("openclaw"));
  const exportPattern = new RegExp(`^export \\{[^}]*\\b${name} as (\\w+)`, "m");
  const matches = fsActual
    .readdirSync(dist)
    .filter((n) => chunkPattern.test(n))
    .map((n) => ({
      file: pathMod.join(dist, n),
      local: exportPattern.exec(fsActual.readFileSync(pathMod.join(dist, n), "utf-8"))?.[1],
    }))
    .filter((m): m is { file: string; local: string } => m.local !== undefined);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${chunkPattern.source} chunk in ${dist} exporting ${name}, found ${String(matches.length)} — re-verify the contract against the installed openclaw version.`
    );
  }
  const mod = (await import(pathToFileURL(matches[0].file).href)) as Record<string, unknown>;
  const fn = mod[matches[0].local];
  if (typeof fn !== "function") {
    throw new Error(`${matches[0].file} exports ${name} as a non-function.`);
  }
  return fn;
}
