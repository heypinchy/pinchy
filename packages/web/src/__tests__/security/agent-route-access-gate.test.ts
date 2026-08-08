// packages/web/src/__tests__/security/agent-route-access-gate.test.ts
//
// Every handler under `/api/agents/[agentId]/` gates on the caller's view of
// the agent, via `getAgentWithAccess`.
//
// Why this is a guard and not a paragraph: the rule was a paragraph, and four
// route families did not follow it. `knowledge/reindex`, `knowledge/unsearchable`,
// `integrations` and the Telegram `GET`/`POST` each looked the agent up by id
// and proceeded, so an admin holding a colleague's agent id could reindex their
// Smithers, read the documents its index cannot search, grant it live access to
// an Odoo or email connection, and attach a Telegram bot to it — while
// `getVisibleAgents`, the chat page and `PATCH`/`DELETE /api/agents/:id` all
// answered "not found" for the same agent. Being an admin is not a visibility
// rule; see `getAgentWithAccess`'s docblock for the verdict.
//
// Closing those four made the prefix uniform. Nothing kept it that way, and the
// docs now state the property outright ("its ID answers 'not found' on every
// management endpoint" — concepts/user-roles.mdx, concepts/agent-permissions.mdx,
// architecture.mdx). A claim in prose that nothing checks is the drift AGENTS.md
// § "A Hand-Maintained List That Mirrors Code Will Be Wrong" catalogues: the one
// list that stayed correct is the one with a guard. The next handler added under
// this prefix inherits the rule, or names itself here.
//
// What it checks, precisely: for each exported HTTP handler, the AST of THAT
// handler contains a call to `getAgentWithAccess`. Per handler, not per file —
// `integrations/route.ts` has three, and a gate on two of them would satisfy any
// file-level count. It walks real call expressions rather than matching text, so
// a comment naming the helper cannot stand in for calling it (these routes
// explain their gate in prose directly above it).
//
// Known limitations, so nobody reads a green run as more than it is:
//
//   - It proves the call is present in the handler, not that it is reached on
//     every path or that its refusal is returned. A handler that called it and
//     ignored the result would pass. Review owns that; the route tests and
//     `agent-admin-routes-visibility.integration.test.ts` cover the behaviour.
//   - Its scope is this one prefix, so it does not speak for `/api/automations`,
//     which takes `agentId` as a query parameter. Those routes reach the same
//     gate through `resolveWorkflowAgent` (#880) and layer a manage-scope 403 on
//     top of it; `resolve-agent.test.ts` is what holds that end. Extending this
//     walk to them would have to model that second gate, which is why they are
//     covered where they live rather than here.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const AGENT_ID_DIR = resolve(__dirname, "../../app/api/agents/[agentId]");
const APP_DIR = resolve(__dirname, "../../app");

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

const ACCESS_GATE = "getAgentWithAccess";

/**
 * Handlers that legitimately do not gate on the caller's view of the agent,
 * each with a written reason.
 *
 * Empty on purpose, and it is meant to stay that way: today all 16 handlers
 * under this prefix gate. An entry is an assertion of fact ("this handler
 * cannot use the gate, because …"), so it takes a reason rather than an issue
 * number — same contract as `raw-fetch-exempt`. It is checked in both
 * directions: an entry for a handler that is gated, or for one that no longer
 * exists, fails like any other drift.
 */
const EXEMPT_HANDLERS: Record<string, string> = {};

function walkRouteFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      result.push(...walkRouteFiles(fullPath));
    } else if (entry === "route.ts" || entry === "route.tsx") {
      result.push(fullPath);
    }
  }
  return result;
}

/** `app/api/agents/[agentId]/uploads/route.ts` → `/api/agents/[agentId]/uploads`. */
function routeFileToPath(file: string): string {
  return "/" + relative(APP_DIR, file).replace(/\/route\.tsx?$/, "");
}

/** True when this subtree calls `getAgentWithAccess(...)` — a call, not a mention. */
function callsAccessGate(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === ACCESS_GATE
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

interface Handler {
  /** e.g. `GET /api/agents/[agentId]/integrations`. */
  id: string;
  gated: boolean;
}

/**
 * Every exported HTTP handler in one route file, in both spellings this tree
 * uses: `export async function GET(…)` and `export const GET = withAdmin(…)`.
 * The wrapper does not need unwrapping — the whole exported declaration is the
 * subtree searched, so `withAdmin(async (…) => { … })` is covered by it.
 */
function extractHandlers(file: string): Handler[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const routePath = routeFileToPath(file);
  const handlers: Handler[] = [];

  const isExported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true;

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
      if (!HTTP_METHODS.has(statement.name.text)) continue;
      handlers.push({
        id: `${statement.name.text} ${routePath}`,
        gated: callsAccessGate(statement),
      });
      continue;
    }

    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (!HTTP_METHODS.has(declaration.name.text)) continue;
        handlers.push({
          id: `${declaration.name.text} ${routePath}`,
          gated: callsAccessGate(declaration),
        });
      }
    }
  }

  return handlers;
}

const handlers = walkRouteFiles(AGENT_ID_DIR).flatMap(extractHandlers);

describe("every /api/agents/[agentId]/ handler gates on the caller's view of the agent", () => {
  // A walk that stops finding handlers reports "no offenders" and reads exactly
  // like a clean pass. 16 handlers exist today; the floor fails long before a
  // broken walk can be mistaken for compliance.
  it("finds the route handlers it is supposed to check", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(15);
  });

  it("gates every handler through getAgentWithAccess", () => {
    const ungated = handlers
      .filter((handler) => !handler.gated && !(handler.id in EXEMPT_HANDLERS))
      .map((handler) => handler.id);

    expect(
      ungated,
      `These handlers under /api/agents/[agentId]/ do not call ${ACCESS_GATE}, so they act on an ` +
        `agent the caller may not be allowed to see — another user's personal agent is withheld ` +
        `from admins too. Gate them:\n\n` +
        `  const agentOrError = await ${ACCESS_GATE}(agentId, session.user.id!, session.user.role);\n` +
        `  if (agentOrError instanceof NextResponse) return agentOrError;\n\n` +
        `Run it BEFORE parsing the body: a validation error only a real id can reach is the same ` +
        `oracle as a 403. If a handler genuinely cannot gate, add it to EXEMPT_HANDLERS with a ` +
        `written reason.\n\nUngated:`
    ).toEqual([]);
  });

  it("carries no exemption that has gone stale", () => {
    const byId = new Map(handlers.map((handler) => [handler.id, handler]));

    for (const [id, reason] of Object.entries(EXEMPT_HANDLERS)) {
      expect(
        reason.trim().length,
        `EXEMPT_HANDLERS["${id}"] needs a written reason`
      ).toBeGreaterThan(10);
      const handler = byId.get(id);
      expect(
        handler,
        `EXEMPT_HANDLERS names "${id}", which is not a handler under this prefix`
      ).toBeDefined();
      // A verdict must not outlive its evidence: once the handler gates, the
      // exemption asserts something that is no longer true.
      expect(
        handler?.gated,
        `EXEMPT_HANDLERS["${id}"] is exempt but now calls ${ACCESS_GATE}`
      ).toBe(false);
    }
  });
});
