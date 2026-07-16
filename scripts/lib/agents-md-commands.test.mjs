import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  extractPnpmInvocations,
  checkAgentsMdCommands,
  createWorkspaceResolver,
} from "./agents-md-commands.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// A resolver over a hand-built workspace, so the pure logic is tested without
// touching the real package.json files.
function fakeResolver(workspace) {
  return (target) => {
    const entry =
      target.type === "dir"
        ? workspace.byDir[target.value]
        : Object.values(workspace.byDir).find((p) => p.name === target.value);
    return entry ? entry.scripts : null;
  };
}

const WORKSPACE = {
  byDir: {
    ".": { name: "pinchy", scripts: ["test", "build"] },
    "packages/web": { name: "@pinchy/web", scripts: ["test", "lint", "format", "db:generate"] },
    docs: { name: "docs", scripts: ["dev", "build"] },
  },
};

test("extractPnpmInvocations reads plain root scripts out of bash blocks", () => {
  const md = ["```bash", "pnpm test", "pnpm build", "```"].join("\n");
  assert.deepEqual(
    extractPnpmInvocations(md).map((i) => ({ dir: i.target.value, script: i.script })),
    [
      { dir: ".", script: "test" },
      { dir: ".", script: "build" },
    ],
  );
});

test("extractPnpmInvocations ignores non-pnpm lines", () => {
  const md = ["```bash", "docker compose up --build", "PINCHY_KEY=x docker compose pull", "```"].join(
    "\n",
  );
  assert.deepEqual(extractPnpmInvocations(md), []);
});

test("extractPnpmInvocations resolves -C into a directory target", () => {
  const md = ["```bash", "pnpm -C packages/web test:db", "```"].join("\n");
  const [inv] = extractPnpmInvocations(md);
  assert.deepEqual(inv.target, { type: "dir", value: "packages/web" });
  assert.equal(inv.script, "test:db");
});

test("extractPnpmInvocations resolves --filter into a package-name target", () => {
  const md = ["```bash", "pnpm --filter @pinchy/web format:check", "```"].join("\n");
  const [inv] = extractPnpmInvocations(md);
  assert.deepEqual(inv.target, { type: "filter", value: "@pinchy/web" });
  assert.equal(inv.script, "format:check");
});

test("extractPnpmInvocations follows `cd` across a && chain", () => {
  const md = ["```bash", "cd docs && pnpm install && pnpm dev", "```"].join("\n");
  const invocations = extractPnpmInvocations(md);
  // `pnpm install` is a builtin, not a script, so only `pnpm dev` is a claim
  // about a script existing.
  assert.deepEqual(
    invocations.map((i) => ({ dir: i.target.value, script: i.script })),
    [{ dir: "docs", script: "dev" }],
  );
});

test("extractPnpmInvocations unwraps `pnpm run <script>`", () => {
  const md = ["```bash", "pnpm run test:scripts", "```"].join("\n");
  assert.equal(extractPnpmInvocations(md)[0].script, "test:scripts");
});

test("checkAgentsMdCommands passes when every documented script exists", () => {
  const md = [
    "```bash",
    "pnpm test",
    "pnpm -C packages/web db:generate",
    "cd docs && pnpm build",
    "```",
  ].join("\n");
  assert.deepEqual(checkAgentsMdCommands(md, fakeResolver(WORKSPACE)), []);
});

test("checkAgentsMdCommands flags a documented script that does not exist", () => {
  // The exact rot this guard exists to catch: AGENTS.md told agents to run
  // `pnpm lint` from the repo root, but only packages/web has that script.
  const md = ["```bash", "pnpm lint", "```"].join("\n");
  const problems = checkAgentsMdCommands(md, fakeResolver(WORKSPACE));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pnpm lint/);
  assert.match(problems[0], /root package\.json|"\."/);
});

test("checkAgentsMdCommands flags a --filter naming an unknown package", () => {
  const md = ["```bash", "pnpm --filter @pinchy/nope test", "```"].join("\n");
  const problems = checkAgentsMdCommands(md, fakeResolver(WORKSPACE));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@pinchy\/nope/);
});

test("createWorkspaceResolver finds every package, not just the root and web", () => {
  const resolver = createWorkspaceResolver(REPO_ROOT);
  // A plugin reached by name — the case the hand-written map used to miss,
  // turning a correctly documented command into a bogus "not a package".
  assert.ok(resolver({ type: "filter", value: "@pinchy/pinchy-odoo" })?.includes("test"));
  assert.ok(resolver({ type: "filter", value: "@pinchy/web" })?.includes("lint"));
  assert.ok(resolver({ type: "dir", value: "." })?.includes("test:scripts"));
  // docs/ is standalone rather than a workspace member, but AGENTS.md
  // documents it, so the guard has to know it.
  assert.ok(resolver({ type: "dir", value: "docs" })?.includes("build"));
});

test("createWorkspaceResolver resolves a glob filter to the union of its matches", () => {
  const resolver = createWorkspaceResolver(REPO_ROOT);
  assert.ok(resolver({ type: "filter", value: "./packages/plugins/*" })?.includes("test"));
  assert.ok(resolver({ type: "filter", value: "@pinchy/*" })?.includes("lint"));
});

test("createWorkspaceResolver still returns null for a package that does not exist", () => {
  const resolver = createWorkspaceResolver(REPO_ROOT);
  assert.equal(resolver({ type: "filter", value: "@pinchy/nope" }), null);
  assert.equal(resolver({ type: "dir", value: "packages/nope" }), null);
});

test("every pnpm command in the real AGENTS.md resolves to a real script", () => {
  const markdown = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
  assert.deepEqual(checkAgentsMdCommands(markdown, createWorkspaceResolver(REPO_ROOT)), []);
});
