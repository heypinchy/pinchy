// packages/web/src/__tests__/lib/log-line-guard.test.ts
//
// The knowledge base's log lines name files from a share, and a file name is
// whatever whoever put it there chose — newlines included. Printed as it
// stands, a name (or an error quoting one) writes lines of its own into the
// server log. `@/lib/log-line` is the one rule for that (`oneLine`,
// `errorLine`); this guard reads every console call in the modules that log
// about share files and fails on one that prints something path-, name- or
// error-shaped without it.
//
// What it checks, precisely: in each `console.{log,info,warn,error,debug}`
// call, every identifier or property chain whose spelling says it holds a path,
// a name or an error (`RISKY`) must sit inside a `oneLine(…)` or
// `errorLine(…)` call. It matches the AST, not text, so a comment mentioning
// `absPath` above a call is not a finding.
//
// Known limitations, so nobody reads a green run as more than it is:
//
//   - It goes by spelling. A path held in a variable called `x` passes; an
//     enum called `reason` is not flagged (and needs no escaping). It is a
//     tripwire against the obvious `${absPath}` / `, err)`, not a proof.
//   - It reads the files in `SCOPE` only — the KB modules, the index worker
//     and the workspace-file route. A new module that logs share paths
//     belongs in that list.
//   - It does not follow a value through a local helper: a string built
//     elsewhere and logged under an innocent name passes.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const SRC_DIR = resolve(__dirname, "../.."); // packages/web/src

/** What a value's spelling says when it may hold a path, a name or an error. */
const RISKY = /path|name|dir|folder|root|err|cause|message/i;

/** The calls that make such a value safe to print in one line. */
const ESCAPERS = new Set(["oneLine", "errorLine"]);

const CONSOLE_METHODS = new Set(["log", "info", "warn", "error", "debug"]);

function walkTs(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "__tests__" ? [] : walkTs(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const SCOPE = [
  ...walkTs(join(SRC_DIR, "lib/knowledge")),
  join(SRC_DIR, "server/kb-index-worker.ts"),
  join(SRC_DIR, "app/api/agents/[agentId]/workspace-file/route.ts"),
];

interface Finding {
  line: number;
  call: string;
  value: string;
}

/** The console calls in `source`, and every risky value one prints unescaped. */
function scanConsoleCalls(source: string): { calls: number; findings: Finding[] } {
  const file = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  let calls = 0;

  const isConsoleCall = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "console" &&
    CONSOLE_METHODS.has(node.expression.name.text);

  const checkValue = (node: ts.Node, call: ts.CallExpression): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && ESCAPERS.has(node.expression.text)) return;
      // A function's own name holds nothing (`basename(…)`); what it is called
      // on (`err.toString()`) and with does.
      if (ts.isPropertyAccessExpression(node.expression)) {
        checkValue(node.expression.expression, call);
      }
      for (const arg of node.arguments) checkValue(arg, call);
      return;
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const text = node.getText(file);
      if (RISKY.test(text)) {
        findings.push({
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          call: call.expression.getText(file),
          value: text,
        });
      }
      return;
    }
    ts.forEachChild(node, (child) => checkValue(child, call));
  };

  const visit = (node: ts.Node): void => {
    if (isConsoleCall(node)) {
      calls++;
      for (const arg of node.arguments) checkValue(arg, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { calls, findings };
}

describe("scanConsoleCalls", () => {
  it("flags a path, a name or an error printed as it stands", () => {
    const { findings } = scanConsoleCalls(`
      console.warn(\`[kb] \${item.absPath}: cut\`);
      console.error(\`[x] failed for \${documentName}:\`, err);
      console.warn(\`[kb] skipped — \${err.message}\`);
      console.log("[kb] " + rootDir);
      console.warn(\`[kb] \${basename(path)}\`);
      console.error(\`[kb] \${err.toString()}\`);
    `);
    expect(findings.map((f) => f.value)).toEqual([
      "item.absPath",
      "documentName",
      "err",
      "err.message",
      "rootDir",
      "path",
      "err",
    ]);
  });

  it("accepts the same values escaped, and values that hold no name", () => {
    const { calls, findings } = scanConsoleCalls(`
      console.warn(\`[kb] \${oneLine(item.absPath, LOG_PATH_MAX)}: cut \${prepared.altChunksRemoved}\`);
      console.error(\`[x] failed for \${oneLine(documentName, 100)}:\`, errorLine(err));
      console.log(\`[w] job \${job.id}: requeued \${requeued} (\${reason})\`);
      // A comment naming \${absPath} is not a call.
      logger.warn(absPath);
    `);
    expect(calls).toBe(3);
    expect(findings).toEqual([]);
  });
});

describe("knowledge-base log lines", () => {
  const scanned = SCOPE.map((path) => ({
    path: relative(SRC_DIR, path),
    ...scanConsoleCalls(readFileSync(path, "utf8")),
  }));

  it("reads the modules it guards", () => {
    // A walker that finds nothing reports no findings too.
    expect(scanned.length).toBeGreaterThan(20);
    expect(scanned.reduce((sum, file) => sum + file.calls, 0)).toBeGreaterThan(15);
  });

  it("print every path, name and error through oneLine or errorLine", () => {
    const findings = scanned.flatMap(({ path, findings }) =>
      findings.map((f) => `${path}:${f.line} ${f.call}(… ${f.value} …)`)
    );
    expect(findings).toEqual([]);
  });
});
