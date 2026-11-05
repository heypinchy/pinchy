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
import ts from "typescript";

export interface RouteReExport {
  /** Absolute path of the module re-exported from. */
  target: string;
  /** `export { HEAD as GET }` → `{ local: "HEAD", exported: "GET" }`. Type-only names are left out. */
  names: Array<{ local: string; exported: string }>;
}

function resolveModule(file: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const base = resolve(dirname(file), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only, paths under the app dir
  return candidates.find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate)) ?? null;
}

/**
 * Parsed, not pattern-matched: a regex reads a re-export quoted in a comment as
 * code, and a comment inside the braces as part of a name — the first lets a
 * route borrow its sibling's auth, the second makes a GET invisible.
 */
export function relativeReExports(file: string, content: string): RouteReExport[] {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const found: RouteReExport[] = [];

  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
    if (statement.isTypeOnly) continue;
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;

    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      throw new Error(
        `${file}: cannot follow \`export * from "${specifier}"\` — name the exports.`
      );
    }
    const target = resolveModule(file, specifier);
    if (target === null) {
      throw new Error(
        `${file}: cannot follow the re-export from "${specifier}" — use a relative path to an existing module.`
      );
    }
    const names = statement.exportClause.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => ({
        local: (element.propertyName ?? element.name).text,
        exported: element.name.text,
      }));
    found.push({ target, names });
  }
  return found;
}
