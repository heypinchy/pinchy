// packages/web/src/__tests__/lib/plugin-fetch-extraction.ts
//
// Shared test helper for plugin-fetch-timeout-coverage.test.ts. Finds every
// `fetch()` call in the plugin sources and reports whether the call passes a
// `signal`.
//
// This file is not a *.test.ts and therefore is not executed by Vitest; it is
// only imported from the guard above.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { PLUGINS_DIR, REPO_ROOT } from "./plugin-tool-extraction";

export type FetchCallSite = {
  /** Repo-relative path, e.g. "packages/plugins/pinchy-audit/index.ts". */
  file: string;
  line: number;
  /** The identifier the call was made through ("fetch", "httpFetch", …). */
  callee: string;
  /** True when the call's init object carries a `signal` property. */
  bounded: boolean;
};

/**
 * Every `.ts` file that ships as plugin production code — tests excluded, since
 * a mocked `fetch` in a test needs no timeout.
 */
export function findPluginSourceFiles(root: string = PLUGINS_DIR): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
      out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Strip `as X` / parentheses so the node underneath can be inspected. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Names in this file that refer to the global `fetch`.
 *
 * Two indirections are real in this tree and both must be followed, or the
 * scan silently reports zero call sites for the file that has the most
 * interesting one: pinchy-web/web-fetch.ts does
 * `import { fetch as undiciFetch } from "undici"` and then
 * `export const httpFetch = undiciFetch as ...`. Resolution runs to a fixpoint
 * rather than in source order, so a later alias of an earlier one is caught
 * regardless of how the file is arranged.
 */
function collectFetchAliases(source: ts.SourceFile): Set<string> {
  const aliases = new Set<string>(["fetch"]);
  let changed = true;

  while (changed) {
    changed = false;
    const add = (name: string) => {
      if (!aliases.has(name)) {
        aliases.add(name);
        changed = true;
      }
    };

    const visit = (node: ts.Node): void => {
      // import { fetch as undiciFetch } from "undici"
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
        const bindings = node.importClause.namedBindings;
        if (ts.isNamedImports(bindings)) {
          for (const spec of bindings.elements) {
            if (spec.propertyName?.text === "fetch") add(spec.name.text);
          }
        }
      }
      // const httpFetch = undiciFetch as (...) => Promise<Response>
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        const init = unwrap(node.initializer);
        if (ts.isIdentifier(init) && aliases.has(init.text)) add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return aliases;
}

/**
 * The callee name when this call goes through the global fetch, else null.
 *
 * A bare `x.fetch(...)` is NOT the global fetch — `imap-adapter.ts` calls
 * `client.fetch(...)` on an ImapFlow connection, and counting that would make
 * the guard demand an AbortSignal from an API that takes none. Only an
 * explicit global receiver qualifies.
 */
function fetchCalleeName(call: ts.CallExpression, aliases: Set<string>): string | null {
  const callee = unwrap(call.expression);

  if (ts.isIdentifier(callee)) {
    return aliases.has(callee.text) ? callee.text : null;
  }

  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch") {
    const receiver = unwrap(callee.expression);
    if (ts.isIdentifier(receiver) && ["globalThis", "global", "window"].includes(receiver.text)) {
      return `${receiver.text}.fetch`;
    }
  }

  return null;
}

/**
 * Does the call's init argument carry a `signal`?
 *
 * Only an object literal written at the call site can answer this. An init
 * passed as a bare variable (`fetch(url, init)`) is deliberately reported as
 * unbounded: the scan cannot see what is inside it, and answering "probably
 * fine" is how a coverage gate becomes decoration.
 */
function callIsBounded(call: ts.CallExpression): boolean {
  const init = call.arguments[1];
  if (!init) return false;

  const literal = unwrap(init as ts.Expression);
  if (!ts.isObjectLiteralExpression(literal)) return false;

  return literal.properties.some((prop) => {
    const name = prop.name;
    if (!name) return false;
    return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "signal";
  });
}

export function findFetchCallSites(files: string[]): FetchCallSite[] {
  const sites: FetchCallSite[] = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const aliases = collectFetchAliases(source);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = fetchCalleeName(node, aliases);
        if (callee) {
          sites.push({
            file: relative(REPO_ROOT, file),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            callee,
            bounded: callIsBounded(node),
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return sites;
}
