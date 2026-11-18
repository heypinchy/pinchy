// packages/web/src/__tests__/security/personal-agent-policy-gate.test.ts
//
// Every production caller of `assertAgentAccess` also calls
// `isPersonalAgentPausedFor`.
//
// `assertAgentAccess` answers "may this caller see this agent". Whether a
// member may USE their own personal agent right now is a second question
// (Settings → Organization → Member access), answered by
// `isPersonalAgentPausedFor`, and it is kept out of the first on purpose: the
// predicate is synchronous and the two refusals say different things — a
// stranger is told the agent does not exist, the owner that it is switched off.
//
// The cost of two functions is that a new door can ask the first and forget the
// second, and a member's Smithers is reachable again through it while every
// other door says it is off. Today there are three doors: `getAgentWithAccess`
// (HTTP), `loadChatPageAgent` (chat pages) and `ClientRouter.handleMessage`
// (WebSocket). `getVisibleAgents` filters lists rather than gating access and
// is pinned by its own test.
//
// It checks calls, not mentions — every one of these files explains the gate
// in prose above it — and resolves import aliases for both names. Per FILE, not
// per function: proving the second call is on every path the first one is on
// needs flow analysis, and the behaviour is pinned by each door's own tests.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const SRC_DIR = resolve(__dirname, "../.."); // packages/web/src
const WEB_DIR = resolve(SRC_DIR, "..");

const ACCESS_GATE = "assertAgentAccess";
const POLICY_GATE = "isPersonalAgentPausedFor";
const SKIP_DIRS = new Set(["__tests__", "test-helpers", "node_modules"]);

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...walkSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.(test|test-d)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** The local names `exported` is bound to in this file, aliases included. */
function localNamesFor(source: ts.SourceFile, exported: string): Set<string> {
  const names = new Set([exported]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === exported) names.add(element.name.text);
    }
  }
  return names;
}

function callsAny(source: ts.SourceFile, names: Set<string>): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && names.has(callee.text)) found = true;
      else if (ts.isPropertyAccessExpression(callee) && names.has(callee.name.text)) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function classifyFile(fileName: string, text: string): "not-a-caller" | "gated" | "ungated" {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  // Defining the predicate is not calling it from a door.
  if (callsAny(source, localNamesFor(source, ACCESS_GATE)) === false) return "not-a-caller";
  return callsAny(source, localNamesFor(source, POLICY_GATE)) ? "gated" : "ungated";
}

describe("every caller of assertAgentAccess consults the personal-agent policy", () => {
  const files = walkSourceFiles(SRC_DIR).filter((f) =>
    readFileSync(f, "utf8").includes(ACCESS_GATE)
  );
  const callers = files
    .map((f) => ({ file: relative(WEB_DIR, f), verdict: classifyFile(f, readFileSync(f, "utf8")) }))
    .filter((c) => c.verdict !== "not-a-caller");

  it("finds the three known doors — a walker that sees nothing must not read as compliance", () => {
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  it("has no door that asks who may see an agent but not whether its owner may use it", () => {
    expect(callers.filter((c) => c.verdict === "ungated").map((c) => c.file)).toEqual([]);
  });
});

describe("classifyFile", () => {
  it("reads a file that calls both gates as gated", () => {
    const text = `import { assertAgentAccess, isPersonalAgentPausedFor } from "@/lib/agent-access";
      export async function f(a) { assertAgentAccess(a, "u", "member"); await isPersonalAgentPausedFor(a, "member"); }`;
    expect(classifyFile("a.ts", text)).toBe("gated");
  });

  it("reads a file that calls only the access gate as ungated", () => {
    const text = `import { assertAgentAccess } from "@/lib/agent-access";
      export function f(a) { assertAgentAccess(a, "u", "member"); }`;
    expect(classifyFile("a.ts", text)).toBe("ungated");
  });

  it("does not count a mention in a comment as the policy call", () => {
    const text = `import { assertAgentAccess } from "@/lib/agent-access";
      // isPersonalAgentPausedFor(agent) runs elsewhere
      export function f(a) { assertAgentAccess(a, "u", "member"); }`;
    expect(classifyFile("a.ts", text)).toBe("ungated");
  });

  it("resolves an aliased import of either gate", () => {
    const text = `import { assertAgentAccess as see, isPersonalAgentPausedFor as paused } from "@/lib/agent-access";
      export async function f(a) { see(a, "u", "member"); await paused(a, "member"); }`;
    expect(classifyFile("a.ts", text)).toBe("gated");
  });

  it("ignores a file that only mentions the access gate", () => {
    const text = `// assertAgentAccess is the read gate\nexport const x = 1;`;
    expect(classifyFile("a.ts", text)).toBe("not-a-caller");
  });
});
