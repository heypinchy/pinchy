// packages/web/src/__tests__/security/workflow-scope-gate-callers.test.ts
//
// Every caller of `canManageAgentWorkflows` runs a VISIBILITY gate in front of
// it, or is named here with a written reason.
//
// The two gates answer different questions and only one of them is about the
// agent's privacy. `canManageAgentWorkflows` returns true for ANY admin on ANY
// agent, while `assertAgentAccess` holds a personal agent private to its owner
// *including admins* — its own comment insists the admin fast-path must not
// bypass that. Where the scope gate runs alone, the admin leg wins, and an admin
// reaches into a colleague's private Smithers. That is what `/api/automations`
// used to do (#880): list, create and the connection picker all consulted the
// predicate by itself, so a logged-in admin could enumerate and create standing
// autonomous authority on an agent `getVisibleAgents` withholds from them.
//
// Running `getAgentWithAccess` first settles it. The verdict is written down in
// three places — `agent-access.ts`, `email-workflows/authz.ts` and
// `resolve-agent.ts` all end on some form of "do not add a caller that consults
// this predicate without a visibility gate in front of it".
//
// Which is exactly the shape AGENTS.md § "A Hand-Maintained List That Mirrors
// Code Will Be Wrong" catalogues: three paragraphs asserting a property, and
// nothing reading the code to see whether it holds. The sibling guard
// `agent-route-access-gate.test.ts` says outright that its scope is the
// `/api/agents/[agentId]/` prefix and that it "does not speak for
// /api/automations". This is the other end.
//
// What it checks, precisely: for each top-level statement that CALLS the scope
// gate, the AST of that same statement also contains a call to a visibility
// gate. It resolves the local binding from the import, so an aliased
// `import { canManageAgentWorkflows as gate }` is still found, and it matches
// call expressions rather than text — every one of these files explains its gate
// in prose directly above it, and a mention must never stand in for a call.
//
// Known limitations, so nobody reads a green run as more than it is:
//
//   - It proves the visibility gate is present in the same statement, not that
//     it is reached on every path or that its refusal is returned. A handler
//     that called it and ignored the result would pass. Review owns that;
//     `resolve-agent.test.ts` and `automations-manage.integration.test.ts` cover
//     the behaviour, admin legs included.
//   - It reads `packages/web/src` production code only. The predicate lives in
//     an `@/lib` module, so nothing outside this package can import it; tests
//     are skipped because a unit test of the predicate calls it on purpose.
//   - The text prefilter (`includes("canManageAgentWorkflows")`) is safe rather
//     than an optimisation-shaped hole: every import spelling — named, aliased,
//     namespace — leaves the exported name in the file.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const SRC_DIR = resolve(__dirname, "../.."); // packages/web/src
const WEB_DIR = resolve(SRC_DIR, ".."); // packages/web

const SCOPE_GATE = "canManageAgentWorkflows";

/**
 * The visibility gates — both spellings of "may this caller SEE this agent".
 * `getAgentWithAccess` returns the 404 response; `assertAgentAccess` throws.
 * A caller reaching for some third gate fails here, which is the point: adding
 * a name to this set is a deliberate act, not a silent one.
 */
const VISIBILITY_GATES = new Set(["getAgentWithAccess", "assertAgentAccess"]);

const SKIP_DIRS = new Set(["__tests__", "test-helpers", "node_modules"]);

/**
 * Callers that consult the scope gate WITHOUT a visibility gate, each with a
 * written reason.
 *
 * An entry asserts a fact ("this caller cannot use the gate, because …"), so it
 * takes a reason rather than an issue number — same contract as
 * `raw-fetch-exempt` and as `EXEMPT_HANDLERS` in the sibling guard. Checked in
 * both directions: an entry for a caller that now gates, or for one that no
 * longer exists, fails like any other drift.
 */
const UNGATED_CALLERS: Record<string, string> = {
  "PATCH src/app/api/automations/[id]/route.ts":
    "Deliberate (#880): keyed by WORKFLOW id, not agent id. An admin who already holds one — from the audit trail, where a runaway automation surfaces — must be able to disable standing autonomous authority even on an agent they cannot see. A visibility gate here would remove the emergency stop. It grants no way to FIND such a workflow: the agentId-keyed routes run the read gate, and every refusal here answers 404.",
  "DELETE src/app/api/automations/[id]/route.ts":
    "Same verdict as PATCH above, for the same route family: stopping a runaway automation on a known workflow id. Discovery stays closed — listing and creating are agentId-keyed and gated.",
};

function walkSourceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) result.push(...walkSourceFiles(fullPath));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|test-d)\.tsx?$/.test(entry)) continue;
    result.push(fullPath);
  }
  return result;
}

/**
 * The local names `exported` is bound to in this file — `{ foo }` and
 * `{ foo as bar }` alike. A namespace import (`import * as authz`) needs no
 * entry: it reaches the function through a property access, which the matcher
 * below recognises by the property name.
 */
function localNamesFor(source: ts.SourceFile, exported: string): Set<string> {
  const names = new Set<string>([exported]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === exported) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

/** How many times this subtree CALLS one of `names` — a call, not a mention. */
function countCalls(node: ts.Node, names: Set<string>): number {
  let count = 0;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && names.has(callee.text)) count++;
      else if (ts.isPropertyAccessExpression(callee) && names.has(callee.name.text)) count++;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return count;
}

function statementName(statement: ts.Statement, source: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(statement) && statement.name) return statement.name.text;
  if (ts.isClassDeclaration(statement) && statement.name) return statement.name.text;
  if (ts.isVariableStatement(statement)) {
    const named = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name));
    if (named) return (named.name as ts.Identifier).text;
  }
  const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
  return `<statement@${line}>`;
}

interface Caller {
  /** e.g. `PATCH src/app/api/automations/[id]/route.ts`. */
  id: string;
  gated: boolean;
  callSites: number;
}

/**
 * Every top-level statement in one file that calls the scope gate, and whether
 * that same statement also calls a visibility gate. Statement granularity, not
 * file granularity: `[id]/route.ts` holds two handlers, and a gate on one of
 * them would satisfy any file-level check.
 */
function extractCallers(file: string): Caller[] {
  const text = readFileSync(file, "utf8");
  if (!text.includes(SCOPE_GATE)) return [];

  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const scopeGateNames = localNamesFor(source, SCOPE_GATE);
  const relativePath = relative(WEB_DIR, file);

  const callers: Caller[] = [];
  for (const statement of source.statements) {
    const callSites = countCalls(statement, scopeGateNames);
    if (callSites === 0) continue;
    callers.push({
      id: `${statementName(statement, source)} ${relativePath}`,
      gated: countCalls(statement, VISIBILITY_GATES) > 0,
      callSites,
    });
  }
  return callers;
}

const callers = walkSourceFiles(SRC_DIR).flatMap(extractCallers);
const callSiteCount = callers.reduce((total, caller) => total + caller.callSites, 0);

describe("every canManageAgentWorkflows caller runs a visibility gate, or says why not", () => {
  // A walk that stops finding call sites reports "no offenders" and reads
  // exactly like a clean pass. Three exist today (resolveWorkflowAgent, and the
  // two workflow-id handlers); the floor fails long before a broken walk or a
  // renamed export can be mistaken for compliance.
  it("finds the call sites it is supposed to check", () => {
    expect(
      callSiteCount,
      `Found ${callSiteCount} call site(s) of ${SCOPE_GATE} in packages/web/src. If the export was ` +
        `renamed or moved, update SCOPE_GATE; a guard that finds nothing passes on an empty ` +
        `comparison.`
    ).toBeGreaterThanOrEqual(3);
  });

  it("gates every caller on the caller's view of the agent", () => {
    const ungated = callers
      .filter((caller) => !caller.gated && !(caller.id in UNGATED_CALLERS))
      .map((caller) => caller.id);

    expect(
      ungated,
      `These call ${SCOPE_GATE} with no visibility gate in front of it. That predicate returns ` +
        `true for ANY admin on ANY agent, so on its own it grants a reach into another user's ` +
        `personal agent that no other agent-scoped surface gives — the #880 bug. Run the read ` +
        `gate first:\n\n` +
        `  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);\n` +
        `  if (agentOrError instanceof NextResponse) return agentOrError;\n\n` +
        `Agent-scoped Automations routes get both gates in the right order from ` +
        `resolveWorkflowAgent — prefer it over open-coding them. If a caller genuinely must not ` +
        `gate, add it to UNGATED_CALLERS with a written reason.\n\nUngated:`
    ).toEqual([]);
  });

  it("carries no exemption that has gone stale", () => {
    const byId = new Map(callers.map((caller) => [caller.id, caller]));

    for (const [id, reason] of Object.entries(UNGATED_CALLERS)) {
      expect(
        reason.trim().length,
        `UNGATED_CALLERS["${id}"] needs a written reason`
      ).toBeGreaterThan(10);
      const caller = byId.get(id);
      expect(
        caller,
        `UNGATED_CALLERS names "${id}", which no longer calls ${SCOPE_GATE}`
      ).toBeDefined();
      // A verdict must not outlive its evidence: once the caller gates, the
      // exemption asserts something that is no longer true.
      expect(
        caller?.gated,
        `UNGATED_CALLERS["${id}"] is exempt but now runs a visibility gate`
      ).toBe(false);
    }
  });
});
