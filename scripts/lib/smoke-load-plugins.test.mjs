import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  PLUGIN_DIR_PREFIX,
  discoverPluginDirs,
  hasIndexEntry,
  readDeclaredTools,
  hasProdDependencies,
  compareToolSets,
  extractImportSpecifiers,
  resolveSiblingModulePath,
  discoverReachableModules,
} from "./smoke-load-plugins.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGINS_ROOT = join(REPO_ROOT, "packages", "plugins");

function makeTempPluginDir() {
  const dir = mkdtempSync(join(tmpdir(), "smoke-load-plugins-test-"));
  return dir;
}

// ---------------------------------------------------------------------------
// discoverPluginDirs
// ---------------------------------------------------------------------------

test("discoverPluginDirs finds every real packages/plugins/pinchy-* package", () => {
  const dirs = discoverPluginDirs(PLUGINS_ROOT);
  assert.ok(dirs.length >= 8, `expected to discover plugin packages, found ${dirs.length}`);
  for (const dir of dirs) {
    assert.match(dir, new RegExp(`${PLUGIN_DIR_PREFIX}[^/]+$`));
  }
  // sorted
  assert.deepEqual(dirs, [...dirs].sort());
});

test("discoverPluginDirs ignores non-plugin directories and files", () => {
  const root = makeTempPluginDir();
  try {
    mkdirSync(join(root, "pinchy-a"));
    mkdirSync(join(root, "not-a-plugin"));
    writeFileSync(join(root, "pinchy-not-a-dir"), "oops");
    const dirs = discoverPluginDirs(root);
    assert.deepEqual(dirs, [join(root, "pinchy-a")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// hasIndexEntry
// ---------------------------------------------------------------------------

test("hasIndexEntry is true when index.ts exists", () => {
  const dir = makeTempPluginDir();
  try {
    writeFileSync(join(dir, "index.ts"), "export default {};");
    assert.equal(hasIndexEntry(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasIndexEntry is false when index.ts is missing", () => {
  const dir = makeTempPluginDir();
  try {
    assert.equal(hasIndexEntry(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readDeclaredTools
// ---------------------------------------------------------------------------

test("readDeclaredTools returns the contracts.tools array", () => {
  const dir = makeTempPluginDir();
  try {
    writeFileSync(
      join(dir, "openclaw.plugin.json"),
      JSON.stringify({ contracts: { tools: ["a", "b"] } }),
    );
    assert.deepEqual(readDeclaredTools(dir), ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDeclaredTools returns an empty array for sidecar plugins with contracts.tools: []", () => {
  const dir = makeTempPluginDir();
  try {
    writeFileSync(
      join(dir, "openclaw.plugin.json"),
      JSON.stringify({ contracts: { tools: [] } }),
    );
    assert.deepEqual(readDeclaredTools(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDeclaredTools returns null when the manifest has no contracts.tools key at all", () => {
  const dir = makeTempPluginDir();
  try {
    writeFileSync(
      join(dir, "openclaw.plugin.json"),
      JSON.stringify({ id: "pinchy-audit" }),
    );
    assert.equal(readDeclaredTools(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDeclaredTools returns null when openclaw.plugin.json is missing", () => {
  const dir = makeTempPluginDir();
  try {
    assert.equal(readDeclaredTools(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDeclaredTools returns null when openclaw.plugin.json is not valid JSON", () => {
  const dir = makeTempPluginDir();
  try {
    writeFileSync(join(dir, "openclaw.plugin.json"), "{not json");
    assert.equal(readDeclaredTools(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDeclaredTools matches every real plugin's manifest without throwing", () => {
  const dirs = discoverPluginDirs(PLUGINS_ROOT);
  for (const dir of dirs) {
    // Must not throw; audit/transcript are expected to come back null (sidecar
    // plugins with no contracts.tools key), everything else an array.
    const tools = readDeclaredTools(dir);
    assert.ok(tools === null || Array.isArray(tools), `${dir}: ${tools}`);
  }
});

// ---------------------------------------------------------------------------
// hasProdDependencies
// ---------------------------------------------------------------------------

test("hasProdDependencies is true when dependencies has at least one entry", () => {
  assert.equal(hasProdDependencies({ dependencies: { googleapis: "^1.0.0" } }), true);
});

test("hasProdDependencies is false when dependencies is empty or absent", () => {
  assert.equal(hasProdDependencies({ dependencies: {} }), false);
  assert.equal(hasProdDependencies({}), false);
  assert.equal(hasProdDependencies({ devDependencies: { vitest: "^1.0.0" } }), false);
});

// ---------------------------------------------------------------------------
// compareToolSets
// ---------------------------------------------------------------------------

test("compareToolSets is ok when the registered and declared sets match exactly", () => {
  const result = compareToolSets(["a", "b"], ["b", "a"]);
  assert.deepEqual(result, { ok: true, missing: [], extra: [] });
});

test("compareToolSets reports declared tools that never got registered (missing)", () => {
  const result = compareToolSets(["a"], ["a", "b"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["b"]);
  assert.deepEqual(result.extra, []);
});

test("compareToolSets reports registered tools that aren't declared (extra)", () => {
  const result = compareToolSets(["a", "b"], ["a"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, ["b"]);
});

test("compareToolSets treats duplicate registrations as a single tool (set semantics)", () => {
  const result = compareToolSets(["a", "a", "b"], ["a", "b"]);
  assert.deepEqual(result, { ok: true, missing: [], extra: [] });
});

test("compareToolSets is empty-vs-empty ok for sidecar plugins with no tools", () => {
  assert.deepEqual(compareToolSets([], []), { ok: true, missing: [], extra: [] });
});

// ---------------------------------------------------------------------------
// extractImportSpecifiers
// ---------------------------------------------------------------------------

test("extractImportSpecifiers finds static named imports", () => {
  const source = `import { foo } from "./foo.js";\nimport bar from "./bar";`;
  assert.deepEqual(extractImportSpecifiers(source), ["./foo.js", "./bar"]);
});

test("extractImportSpecifiers finds re-exports (export ... from)", () => {
  const source = `export { foo } from "./foo.js";\nexport type { Bar } from "./bar.js";`;
  assert.deepEqual(extractImportSpecifiers(source), ["./foo.js", "./bar.js"]);
});

test("extractImportSpecifiers finds dynamic import() calls", () => {
  const source = `async function f() {\n  const { X } = await import("./adapter.js");\n}`;
  assert.deepEqual(extractImportSpecifiers(source), ["./adapter.js"]);
});

test("extractImportSpecifiers finds bare-import side-effect statements", () => {
  const source = `import "./side-effect.js";`;
  assert.deepEqual(extractImportSpecifiers(source), ["./side-effect.js"]);
});

test("extractImportSpecifiers dedupes repeated specifiers, keeping first-seen order", () => {
  const source = `import { a } from "./x.js";\nimport { b } from "./x.js";\nimport "./y.js";`;
  assert.deepEqual(extractImportSpecifiers(source), ["./x.js", "./y.js"]);
});

test("extractImportSpecifiers includes bare package specifiers too (caller filters them out)", () => {
  const source = `import { google } from "googleapis";\nimport { foo } from "./foo.js";`;
  assert.deepEqual(extractImportSpecifiers(source), ["googleapis", "./foo.js"]);
});

test("extractImportSpecifiers returns an empty array for source with no imports", () => {
  assert.deepEqual(extractImportSpecifiers("export const x = 1;"), []);
});

// ---------------------------------------------------------------------------
// resolveSiblingModulePath
// ---------------------------------------------------------------------------

test("resolveSiblingModulePath maps a .js-suffixed relative specifier to the sibling .ts file", () => {
  assert.equal(
    resolveSiblingModulePath("/plugin", "./adapter.js"),
    join("/plugin", "adapter.ts"),
  );
});

test("resolveSiblingModulePath maps an extensionless relative specifier to .ts", () => {
  assert.equal(
    resolveSiblingModulePath("/plugin", "./adapter"),
    join("/plugin", "adapter.ts"),
  );
});

test("resolveSiblingModulePath handles ../ parent-relative specifiers", () => {
  assert.equal(
    resolveSiblingModulePath("/plugin/sub", "../adapter.js"),
    join("/plugin", "adapter.ts"),
  );
});

test("resolveSiblingModulePath returns null for a bare package specifier", () => {
  assert.equal(resolveSiblingModulePath("/plugin", "googleapis"), null);
});

test("resolveSiblingModulePath returns null for a scoped package specifier", () => {
  assert.equal(resolveSiblingModulePath("/plugin", "@napi-rs/canvas"), null);
});

// ---------------------------------------------------------------------------
// discoverReachableModules
// ---------------------------------------------------------------------------

test("discoverReachableModules follows static imports transitively from the entry file", () => {
  const dir = makeTempPluginDir();
  try {
    writeFileSync(
      join(dir, "index.ts"),
      `import { a } from "./a.js";\nexport default { register() {} };`,
    );
    writeFileSync(join(dir, "a.ts"), `import { b } from "./b.js";\nexport const a = 1;`);
    writeFileSync(join(dir, "b.ts"), `export const b = 1;`);
    writeFileSync(join(dir, "unreachable.ts"), `import "some-dev-only-package";\nexport const u = 1;`);

    const modules = discoverReachableModules(dir);
    const names = modules.map((m) => m.split("/").pop()).sort();
    assert.deepEqual(names, ["a.ts", "b.ts", "index.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverReachableModules follows dynamic import() specifiers too", () => {
  const dir = makeTempPluginDir();
  try {
    writeFileSync(
      join(dir, "index.ts"),
      `export default { async register() { await import("./lazy-adapter.js"); } };`,
    );
    writeFileSync(join(dir, "lazy-adapter.ts"), `import "some-prod-dep";\nexport const x = 1;`);

    const modules = discoverReachableModules(dir);
    const names = modules.map((m) => m.split("/").pop()).sort();
    assert.deepEqual(names, ["index.ts", "lazy-adapter.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverReachableModules never revisits a module twice even with import cycles", () => {
  const dir = makeTempPluginDir();
  try {
    writeFileSync(join(dir, "index.ts"), `import "./a.js";\nexport default {};`);
    writeFileSync(join(dir, "a.ts"), `import "./index.js";\nexport const a = 1;`);

    const modules = discoverReachableModules(dir);
    const names = modules.map((m) => m.split("/").pop()).sort();
    assert.deepEqual(names, ["a.ts", "index.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverReachableModules does not pull in a sibling that nothing imports (e.g. a dev-only fixture generator script)", () => {
  const dir = makeTempPluginDir();
  try {
    writeFileSync(join(dir, "index.ts"), `export default { register() {} };`);
    // A standalone dev-tooling script that imports a devDependency, never
    // referenced by index.ts. Reachability-based discovery must not pull this
    // in — otherwise a plugin whose dev scripts import devDependencies would
    // fail smoke-load even though OpenClaw never loads that file at runtime.
    writeFileSync(join(dir, "generate-fixtures.ts"), `import { Document } from "docx";\nexport {};`);

    const modules = discoverReachableModules(dir);
    const names = modules.map((m) => m.split("/").pop());
    assert.deepEqual(names, ["index.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverReachableModules returns an empty array when the entry file doesn't exist", () => {
  const dir = makeTempPluginDir();
  try {
    assert.deepEqual(discoverReachableModules(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Drift-guard style sanity check against every real plugin: discovery must not
// throw and must always include index.ts when present.
// ---------------------------------------------------------------------------

test("discoverReachableModules runs cleanly against every real plugin package", () => {
  const dirs = discoverPluginDirs(PLUGINS_ROOT);
  for (const dir of dirs) {
    if (!hasIndexEntry(dir)) continue;
    const modules = discoverReachableModules(dir);
    assert.ok(modules.length >= 1, `expected at least index.ts for ${dir}`);
    assert.ok(
      modules.some((m) => m.endsWith("/index.ts")),
      `expected index.ts to be included for ${dir}`,
    );
  }
});
