// packages/web/src/__tests__/lib/plugin-error-details-extraction.ts
//
// Static AST scan backing plugin-tool-error-details-drift.test.ts.
//
// The #404 contract (see pinchy-odoo's and pinchy-email's `toolError()` doc
// comments): OpenClaw strips the MCP `isError` flag before forwarding a tool
// result to /api/internal/audit/tool-use, so the audit route's only
// remaining failure signal is `result.details.error`. A return literal that
// sets `isError: true` without a sibling `details.error` is therefore
// audited as `outcome: success` — a failed tool call reads as a successful
// one in the audit trail.
//
// This file is not a *.test.ts and therefore is not executed by Vitest; it is
// only imported from plugin-tool-error-details-drift.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  KNOWN_PINCHY_PLUGINS,
  type KnownPinchyPlugin,
} from "@/lib/openclaw-config/plugin-manifest-loader";
import { PLUGINS_DIR } from "./plugin-tool-extraction";

export { KNOWN_PINCHY_PLUGINS };
export type { KnownPinchyPlugin };

/**
 * Why a result literal was flagged.
 *
 * - `missing-details-error`: it sets `isError: true` with no sibling
 *   `details.error`, so the audit route records `outcome: success`.
 * - `dynamic-is-error`: `isError` is neither literal `true` nor literal
 *   `false`, so this scan cannot tell whether the failure path carries
 *   `details.error`. That is not a hypothetical shape — `pinchy_web_fetch`
 *   forwarded `isError: result.isError` straight from webFetch(), which is
 *   exactly how it shipped without details.error. Branch on the flag and
 *   return a `toolError()` on the error side instead, so the contract is
 *   visible to this scan.
 */
export type ErrorDetailIssueReason = "missing-details-error" | "dynamic-is-error";

export interface MissingErrorDetail {
  /** 1-based line number in the plugin's index.ts. */
  line: number;
  /** First line of the offending object literal, for a readable failure message. */
  snippet: string;
  reason: ErrorDetailIssueReason;
}

export interface ErrorResultScan {
  /**
   * How many result literals carried an `isError` worth judging (everything
   * but a literal `false`). The guard asserts this against a floor: a walk
   * that silently stops finding anything would otherwise pass as "no drift".
   */
  checked: number;
  issues: MissingErrorDetail[];
}

/**
 * Strip the wrappers TypeScript allows around a literal so `true as const`
 * and `(true)` read the same as a bare `true`. `true as const` is not
 * hypothetical: pinchy-email's session-less tool stub is written that way,
 * and an `expr.kind === TrueKeyword` check skips the whole literal — silently
 * exempting exactly one of the results this guard exists to cover.
 */
function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/**
 * A property is present when it is assigned (`error: msg`), written in
 * shorthand (`error`), or quoted (`"error": msg`). Matching only
 * PropertyAssignment+Identifier reports correct shorthand code as a
 * violation, which is the failure mode that gets a guard switched off.
 */
function findProperty(
  node: ts.ObjectLiteralExpression,
  name: string
): { initializer: ts.Expression | undefined; node: ts.ObjectLiteralElementLike } | undefined {
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const propName = prop.name;
      const matches =
        (ts.isIdentifier(propName) && propName.text === name) ||
        (ts.isStringLiteral(propName) && propName.text === name);
      if (matches) return { initializer: prop.initializer, node: prop };
    } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) {
      // `{ error }` — the value is the identifier itself, which this static
      // scan cannot resolve. Presence is what the contract asks for.
      return { initializer: undefined, node: prop };
    }
  }
  return undefined;
}

function hasErrorProperty(details: ts.Expression | undefined): boolean {
  if (details === undefined) return false;
  const unwrapped = unwrapExpression(details);
  if (!ts.isObjectLiteralExpression(unwrapped)) return false;
  return findProperty(unwrapped, "error") !== undefined;
}

/**
 * Find every object-literal MCP tool result in `source` that signals a
 * failure without a `details.error` the audit route can read. Mirrors the
 * AST-walk style of `plugin-tool-extraction.ts`'s `skippedRanges` rather
 * than a line-oriented regex, because the two properties in question
 * (`isError` and `details`) can be reordered or separated by other curated
 * fields (see pinchy-files' `pinchy_write`, which also carries
 * `path`/`mode`/`overwrite`) and a regex anchored on adjacency would miss
 * those.
 *
 * Takes a source string rather than a path so the scan itself is testable
 * against fixtures, the way `extractCoveredTools` is — a scan only ever
 * exercised against healthy real sources can degrade into a no-op and stay
 * green.
 *
 * Known limitation, stated plainly: a `details` that is not an object
 * literal (`details: buildDetails(x)`) is reported as missing. That is
 * deliberate — the scan cannot follow the value, and a guard that assumes
 * the best about what it cannot read is the same silence it exists to
 * remove. Route such a result through a `toolError()`-style helper.
 */
export function scanErrorResults(source: string, fileName = "index.ts"): ErrorResultScan {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  const issues: MissingErrorDetail[] = [];
  let checked = 0;

  const flag = (element: ts.Node, reason: ErrorDetailIssueReason): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
    issues.push({ line: line + 1, snippet: element.getText(sourceFile).trim(), reason });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const isErrorProp = findProperty(node, "isError");
      if (isErrorProp !== undefined) {
        const initializer =
          isErrorProp.initializer !== undefined
            ? unwrapExpression(isErrorProp.initializer)
            : undefined;
        // `isError: false` is a success result; nothing to check.
        if (initializer === undefined || initializer.kind !== ts.SyntaxKind.FalseKeyword) {
          checked++;
          if (initializer !== undefined && initializer.kind === ts.SyntaxKind.TrueKeyword) {
            if (!hasErrorProperty(findProperty(node, "details")?.initializer)) {
              flag(isErrorProp.node, "missing-details-error");
            }
          } else {
            flag(isErrorProp.node, "dynamic-is-error");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { checked, issues };
}

/**
 * Scan a plugin's `index.ts`.
 *
 * Scope is `index.ts` alone, matching `deriveToolsFromSource`: every plugin
 * registers its tools there, and a result literal travels with the handler
 * that builds it. A plugin that ever builds an MCP result in a sibling
 * module escapes this scan — pinchy-web's `web-fetch.ts` returns a
 * different, internal `{ content: string; isError }` DTO that index.ts
 * translates, so nothing escapes today.
 *
 * An unreadable index.ts throws rather than reporting "no issues": every
 * finding here is an absence, so a failed read and a clean file are the same
 * empty list. `deriveToolsFromSource` can afford to swallow it — an empty
 * tool list turns its manifest comparison red — but here it would turn the
 * guard green for a plugin it never opened.
 */
export function scanPlugin(pluginId: KnownPinchyPlugin): ErrorResultScan {
  const indexPath = join(PLUGINS_DIR, pluginId, "index.ts");
  let source: string;
  try {
    source = readFileSync(indexPath, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read ${indexPath} for plugin ${pluginId}. This guard reports absences, so an ` +
        `unreadable file would otherwise pass as "no drift". If the plugin moved its tool ` +
        `results out of index.ts, widen this scan rather than dropping the plugin. ` +
        `(${err instanceof Error ? err.message : String(err)})`
    );
  }
  return scanErrorResults(source, `${pluginId}/index.ts`);
}
