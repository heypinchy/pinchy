/**
 * The relative re-exports in a route file, resolved to the files they name.
 *
 * A route can serve another route's handler under a url of its own with one
 * line — the citation viewer's `workspace-file/[name]/route.ts` is
 * `export { GET } from "../route"` (#1268). The security guards read route
 * files as text or AST, and that line carries none of what they look for: no
 * auth call, no frame header, no handler body. Each guard follows the
 * re-export through this one reading instead of growing its own.
 *
 * Throws on a re-export it cannot follow (`export * from`, an aliased or bare
 * specifier, a target that does not exist). The alternative is a guard that
 * reads the file as empty, which for some guards is a pass.
 *
 * Test-only.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface RouteReExport {
  /** Absolute path of the module re-exported from. */
  target: string;
  /** `export { HEAD as GET }` → `{ local: "HEAD", exported: "GET" }`. */
  names: Array<{ local: string; exported: string }>;
}

const NAMED_RE_EXPORT = /export\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const STAR_RE_EXPORT = /export\s*\*\s*(?:as\s+\w+\s*)?from\s*["']([^"']+)["']/;

function resolveModule(file: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const base = resolve(dirname(file), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only, paths under the app dir
  return candidates.find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate)) ?? null;
}

export function relativeReExports(file: string, content: string): RouteReExport[] {
  const star = STAR_RE_EXPORT.exec(content);
  if (star) {
    throw new Error(`${file}: cannot follow \`export * from "${star[1]}"\` — name the exports.`);
  }

  const found: RouteReExport[] = [];
  for (const [, list, specifier] of content.matchAll(NAMED_RE_EXPORT)) {
    const target = resolveModule(file, specifier);
    if (target === null) {
      throw new Error(
        `${file}: cannot follow the re-export from "${specifier}" — use a relative path to an existing module.`
      );
    }
    const names = list
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [local, exported] = entry.split(/\s+as\s+/).map((part) => part.trim());
        return { local, exported: exported ?? local };
      });
    found.push({ target, names });
  }
  return found;
}
