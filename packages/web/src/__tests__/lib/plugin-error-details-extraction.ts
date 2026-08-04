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

export interface MissingErrorDetail {
  /** 1-based line number in the plugin's index.ts. */
  line: number;
  /** First line of the offending object literal, for a readable failure message. */
  snippet: string;
}

function isLiteralTrue(expr: ts.Expression): boolean {
  return expr.kind === ts.SyntaxKind.TrueKeyword;
}

function findProperty(
  node: ts.ObjectLiteralExpression,
  name: string
): ts.PropertyAssignment | undefined {
  const prop = node.properties.find(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name
  );
  return prop as ts.PropertyAssignment | undefined;
}

function hasErrorProperty(details: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(details)) return false;
  return findProperty(details, "error") !== undefined;
}

/**
 * Find every object-literal MCP tool result in a plugin's index.ts that sets
 * `isError: true` but does not also carry a `details` object with an `error`
 * key. Mirrors the AST-walk style of `plugin-tool-extraction.ts`'s
 * `skippedRanges` rather than a line-oriented regex, because the two
 * properties in question (`isError` and `details`) can be reordered or
 * separated by other curated fields (see pinchy-files' `pinchy_write`, which
 * also carries `path`/`mode`/`overwrite`) and a regex anchored on adjacency
 * would miss those.
 *
 * Deliberately a static scan, not a type check: it inspects
 * ObjectLiteralExpression nodes only, so a dynamically-computed `isError`
 * value (e.g. `isError: someFlag`) is out of scope. Every call site in this
 * repo assigns the literal `true` (or routes through a `toolError()`-style
 * helper, which is itself scanned once at its own declaration site).
 */
export function findMissingErrorDetails(pluginId: KnownPinchyPlugin): MissingErrorDetail[] {
  const indexPath = join(PLUGINS_DIR, pluginId, "index.ts");
  let source: string;
  try {
    source = readFileSync(indexPath, "utf8");
  } catch {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    "index.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  const issues: MissingErrorDetail[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const isErrorProp = findProperty(node, "isError");
      if (isErrorProp && isLiteralTrue(isErrorProp.initializer)) {
        const detailsProp = findProperty(node, "details");
        const ok = detailsProp !== undefined && hasErrorProperty(detailsProp.initializer);
        if (!ok) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            isErrorProp.getStart(sourceFile)
          );
          issues.push({
            line: line + 1,
            snippet: isErrorProp.getText(sourceFile).trim(),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return issues;
}
