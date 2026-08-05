import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { BOOTSTRAP_FILENAMES } from "@/lib/workspace";

/**
 * `BOOTSTRAP_FILENAMES` mirrors OpenClaw's `loadWorkspaceBootstrapFiles` — the
 * exact set of files OpenClaw embeds as prompt context — and Pinchy measures
 * those files to size the per-agent `bootstrapMaxChars` / `bootstrapTotalMaxChars`
 * (#373). A hand-maintained list that mirrors code will be wrong: this one was
 * missing `MEMORY.md` from the day it was written, which is the one entry OpenClaw
 * loads LAST and therefore squeezes out first.
 *
 * So the list is checked against the pinned OpenClaw bundle rather than against a
 * second hand-written copy. openclaw is a devDependency of packages/web, so the
 * bundle is present wherever the suite runs.
 *
 * The extractor THROWS on anything it cannot read — a renamed chunk, a changed
 * shape, an unresolvable constant. A guard that answers "no drift" on input it
 * failed to parse is how a mirror-list check stops checking, which is exactly the
 * failure this test exists to catch one level down.
 */
const OPENCLAW_DIST = join(process.cwd(), "node_modules/openclaw/dist");

// The chunk is named after its source module (`src/agents/workspace.ts`), so the
// prefix is stable across versions while the content hash is not.
const BUNDLE_PATTERN = /^workspace.*\.js$/;

const FN_ANCHOR = "async function loadWorkspaceBootstrapFiles";

function readDist(name: string): string {
  return readFileSync(join(OPENCLAW_DIST, name), "utf-8");
}

function findBundleContainingLoader(): string {
  let candidates: string[];
  try {
    candidates = readdirSync(OPENCLAW_DIST).filter((name) => BUNDLE_PATTERN.test(name));
  } catch (err) {
    throw new Error(
      `cannot read the OpenClaw dist at ${OPENCLAW_DIST} (${String(err)}). ` +
        "openclaw is a devDependency of packages/web — run `pnpm install`."
    );
  }

  for (const name of candidates) {
    if (readDist(name).includes(FN_ANCHOR)) return name;
  }

  throw new Error(
    `no bundle matching ${BUNDLE_PATTERN} in ${OPENCLAW_DIST} contains "${FN_ANCHOR}" ` +
      `(searched ${candidates.length} file(s)). OpenClaw moved or renamed the loader — ` +
      "re-locate it and update BUNDLE_PATTERN/FN_ANCHOR before trusting this guard."
  );
}

const IDENT = "[A-Za-z_$][\\w$]*";
const IDENT_ONLY = /^[A-Za-z_$][\w$]*$/;
// Chunk filenames are `<module>-<hash>.js`, always flat inside dist/.
const CHUNK_NAME_ONLY = /^[\w.-]+\.js$/;

/**
 * Every value read out of the bundle is validated before it is spliced into a
 * pattern or a path. Nothing here is attacker-controlled — it is a pinned
 * devDependency — but a value that does not look like an identifier means the
 * parse went wrong, and turning that into a thrown error rather than an odd
 * regex is the same fail-loud rule the rest of this file follows.
 */
function escapeIdent(identifier: string): string {
  if (!IDENT_ONLY.test(identifier)) {
    throw new Error(`parsed \`${identifier}\` where a JS identifier was expected`);
  }
  return identifier.replace(/\$/g, "\\$");
}

function assertChunkName(chunk: string): string {
  if (!CHUNK_NAME_ONLY.test(chunk)) {
    throw new Error(`parsed \`${chunk}\` where a dist chunk filename was expected`);
  }
  return chunk;
}

/**
 * Resolves a bundled constant to its string literal, following one `const a = b`
 * alias and, when the binding is imported from a sibling chunk, that import too
 * (`DEFAULT_MEMORY_FILENAME` is `CANONICAL_ROOT_MEMORY_FILENAME`, which lives in
 * the root-memory-files chunk). Throws on anything it cannot follow.
 */
function resolveStringConstant(source: string, identifier: string, depth = 3): string {
  if (depth <= 0) {
    throw new Error(`bootstrap filename constant \`${identifier}\` aliases too deeply to resolve`);
  }

  const declaration = new RegExp(
    `\\bconst ${escapeIdent(identifier)}\\s*=\\s*(?:"([^"]+)"|(${IDENT}))`
  ).exec(source);
  if (declaration) {
    if (declaration[1] !== undefined) return declaration[1];
    return resolveStringConstant(source, declaration[2], depth - 1);
  }

  const imported = resolveImportedBinding(source, identifier);
  if (imported) return resolveStringConstant(imported.source, imported.localName, depth - 1);

  throw new Error(`no declaration for bootstrap filename constant \`${identifier}\``);
}

/**
 * Follows `import { <exported> as <identifier> } from "./chunk.js"` into the
 * chunk and maps the exported alias back to its local declaration name via that
 * chunk's `export { <local> as <exported> }` list.
 */
function resolveImportedBinding(
  source: string,
  identifier: string
): { source: string; localName: string } | null {
  const importMatch = new RegExp(
    `import\\s*\\{([^}]*\\b${escapeIdent(identifier)}\\b[^}]*)\\}\\s*from\\s*"\\.\\/([^"]+)"`
  ).exec(source);
  if (!importMatch) return null;

  const [, bindings, chunk] = importMatch;
  const aliased = new RegExp(`(${IDENT})\\s+as\\s+${escapeIdent(identifier)}\\b`).exec(bindings);
  const exportedName = aliased ? aliased[1] : identifier;

  const chunkSource = readDist(assertChunkName(chunk));
  const localMatch = new RegExp(`(${IDENT})\\s+as\\s+${escapeIdent(exportedName)}\\b`).exec(
    chunkSource
  );
  return { source: chunkSource, localName: localMatch ? localMatch[1] : exportedName };
}

/**
 * Reads the filenames `loadWorkspaceBootstrapFiles` builds its entry list from.
 * The bundle is not minified, so the entries appear as `name: DEFAULT_X_FILENAME`.
 */
function extractOpenClawBootstrapFilenames(): string[] {
  const source = readDist(findBundleContainingLoader());
  const start = source.indexOf(FN_ANCHOR);
  const listEnd = source.indexOf("const result = [];", start);
  if (listEnd === -1) {
    throw new Error(
      `could not find the end of the entry list after "${FN_ANCHOR}" — the loader's ` +
        "shape changed; re-read it before trusting this guard."
    );
  }

  const body = source.slice(start, listEnd);
  const identifiers = [...body.matchAll(new RegExp(`\\bname:\\s*(${IDENT})`, "g"))].map(
    (m) => m[1]
  );
  if (identifiers.length === 0) {
    throw new Error(
      `parsed 0 bootstrap entries out of "${FN_ANCHOR}" — the loader stopped spelling its ` +
        "entries as `name: <CONST>`; re-read it before trusting this guard."
    );
  }

  return identifiers.map((identifier) => resolveStringConstant(source, identifier));
}

describe("BOOTSTRAP_FILENAMES ↔ OpenClaw loadWorkspaceBootstrapFiles", () => {
  it("names every file OpenClaw embeds as bootstrap context, and no others", () => {
    const upstream = extractOpenClawBootstrapFilenames();

    // Corpus floor: a parse that silently degraded to one or two entries would
    // otherwise "pass" against a list that happens to contain them.
    expect(upstream.length).toBeGreaterThanOrEqual(7);
    expect(upstream).toContain("MEMORY.md");

    // Compared as sets: Pinchy sums and maxes the sizes, so upstream reordering is
    // not drift. The ORDER still matters for reading a failure — MEMORY.md is last
    // upstream, so it is the first file squeezed out by the total budget.
    expect([...BOOTSTRAP_FILENAMES].sort()).toEqual([...upstream].sort());
  });

  it("fails loudly rather than quietly when a constant cannot be resolved", () => {
    // The property that makes the check above worth anything: unreadable input is
    // an error, never an empty diff.
    expect(() => resolveStringConstant('const OTHER = "x";', "MISSING_CONST")).toThrow(
      "no declaration for bootstrap filename constant `MISSING_CONST`"
    );
  });
});
