import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import {
  API_DOC_EXEMPTIONS,
  AUDIT_EVENT_DOC_EXEMPTIONS,
  TOOL_DOC_EXEMPTIONS,
  extractAuditEventTypes,
  extractDocumentedEndpoints,
  extractGrantableTools,
  extractRouteHandlers,
  findUndocumentedAuditEvents,
  findUndocumentedEndpoints,
  findUndocumentedTools,
  normalizeRoute,
} from "./docs-coverage.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APP_API = join(REPO_ROOT, "packages/web/src/app/api");
const DOCS = join(REPO_ROOT, "docs/src/content/docs");
const PLUGINS = join(REPO_ROOT, "packages/plugins");

// ── pure logic ────────────────────────────────────────────────────────────

test("normalizeRoute erases the parameter-name disagreement between code and docs", () => {
  assert.equal(
    normalizeRoute("/api/agents/[agentId]/uploads"),
    "/api/agents/{}/uploads",
  );
  assert.equal(normalizeRoute("/api/agents/:id"), "/api/agents/{}");
  assert.equal(normalizeRoute("/api/auth/[...all]"), "/api/auth/{}");
  // Same endpoint, three spellings, one key.
  assert.equal(
    normalizeRoute("/api/agents/[id]"),
    normalizeRoute("/api/agents/:agentId"),
  );
});

test("extractRouteHandlers reads both export styles and skips files with no handler", () => {
  const handlers = extractRouteHandlers([
    {
      path: "api/a/route.ts",
      source: "export async function GET() {}\nexport const POST = x;",
    },
    { path: "api/b/route.ts", source: "export function GET() {}" },
    { path: "api/c/route.ts", source: "export const runtime = 'nodejs';" },
  ]);
  assert.deepEqual(handlers, [
    { route: "/api/a", methods: ["GET", "POST"] },
    { route: "/api/b", methods: ["GET"] },
  ]);
});

test("extractRouteHandlers sees a destructured library re-export", () => {
  // Better Auth's catch-all is the only route that ships this shape; a walker
  // that misses it drops a real route out of the checked set.
  const handlers = extractRouteHandlers([
    {
      path: "api/auth/[...all]/route.ts",
      source: "export const { POST, GET } = toNextJsHandler(auth);",
    },
  ]);
  assert.deepEqual(handlers, [
    { route: "/api/auth/[...all]", methods: ["GET", "POST"] },
  ]);
});

test("extractRouteHandlers does not mistake a mentioned method for an exported one", () => {
  const handlers = extractRouteHandlers([
    {
      path: "api/a/route.ts",
      source: "// Callers use DELETE here.\nexport async function GET() {}",
    },
  ]);
  assert.deepEqual(handlers, [{ route: "/api/a", methods: ["GET"] }]);
});

test("extractDocumentedEndpoints drops the query string but keeps the path", () => {
  const set = extractDocumentedEndpoints(
    "### `GET /api/settings/providers/deletion-preview?provider=<nameOrSlug>`",
  );
  assert.ok(set.has("GET /api/settings/providers/deletion-preview"));
});

test("findUndocumentedEndpoints reports only the missing methods of a partly documented route", () => {
  const problems = findUndocumentedEndpoints(
    [{ route: "/api/agents/[id]", methods: ["GET", "DELETE"] }],
    new Set(["GET /api/agents/{}"]),
    {},
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^DELETE \/api\/agents\/\[id\]/);
});

test("findUndocumentedEndpoints honours an exemption", () => {
  assert.deepEqual(
    findUndocumentedEndpoints(
      [{ route: "/api/dev/x", methods: ["POST"] }],
      new Set(),
      {
        "/api/dev/x": "development-only",
      },
    ),
    [],
  );
});

test("extractAuditEventTypes takes the literals and skips the tool.* family", () => {
  const types = extractAuditEventTypes(
    'export type AuditEventType =\n | `tool.${string}`\n | "agent.created"\n | "agent.deleted";',
  );
  assert.deepEqual(types, ["agent.created", "agent.deleted"]);
});

test("extractAuditEventTypes fails loudly when the union moves", () => {
  assert.throws(
    () => extractAuditEventTypes("export type Something = string;"),
    /AuditEventType/,
  );
});

test("extractGrantableTools unions the registry with the plugin manifests", () => {
  assert.deepEqual(
    extractGrantableTools('  {\n    id: "pinchy_write",\n', [
      { id: "pinchy-knowledge", tools: ["knowledge_search"] },
      { id: "pinchy-audit", tools: undefined },
    ]),
    ["knowledge_search", "pinchy_write"],
  );
});

test("findUndocumentedTools points at the page the reader would look on", () => {
  const problems = findUndocumentedTools(
    ["knowledge_search"],
    "no mention here",
    {},
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /agent-permissions\.mdx/);
});

// ── the repo itself ───────────────────────────────────────────────────────
//
// The assertions above prove the checker works; these prove the docs are
// actually covered. Without them the guard is a unit test of a function
// nobody runs against anything.

/** @returns {Array<{path: string, source: string}>} every api route.ts */
function readRouteFiles(dir = APP_API) {
  /** @type {Array<{path: string, source: string}>} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...readRouteFiles(abs));
    else if (entry === "route.ts") {
      out.push({
        path: "api/" + relative(APP_API, abs).split("\\").join("/"),
        source: readFileSync(abs, "utf8"),
      });
    }
  }
  return out;
}

function readPluginManifests() {
  return readdirSync(PLUGINS)
    .filter((d) => d.startsWith("pinchy-"))
    .map((d) => {
      const manifest = JSON.parse(
        readFileSync(join(PLUGINS, d, "openclaw.plugin.json"), "utf8"),
      );
      return { id: d, tools: manifest.contracts?.tools ?? [] };
    });
}

test("every API route is in the API reference", () => {
  const handlers = extractRouteHandlers(readRouteFiles());
  // Guard the guard: a broken walker that finds nothing would pass silently.
  assert.ok(
    handlers.length > 50,
    `expected the full route set, found ${handlers.length}`,
  );
  const documented = extractDocumentedEndpoints(
    readFileSync(join(DOCS, "reference/api.mdx"), "utf8"),
  );
  assert.deepEqual(findUndocumentedEndpoints(handlers, documented), []);
});

test("every audit event type is in the audit-trail reference", () => {
  const types = extractAuditEventTypes(
    readFileSync(join(REPO_ROOT, "packages/web/src/lib/audit.ts"), "utf8"),
  );
  assert.ok(
    types.length > 40,
    `expected the full event set, found ${types.length}`,
  );
  assert.deepEqual(
    findUndocumentedAuditEvents(
      types,
      readFileSync(join(DOCS, "concepts/audit-trail.mdx"), "utf8"),
    ),
    [],
  );
});

test("every grantable tool is in the agent-permissions reference", () => {
  const tools = extractGrantableTools(
    readFileSync(
      join(REPO_ROOT, "packages/web/src/lib/tool-registry.ts"),
      "utf8",
    ),
    readPluginManifests(),
  );
  assert.ok(
    tools.length > 20,
    `expected the full tool set, found ${tools.length}`,
  );
  assert.deepEqual(
    findUndocumentedTools(
      tools,
      readFileSync(join(DOCS, "concepts/agent-permissions.mdx"), "utf8"),
    ),
    [],
  );
});

test("no exemption outlives the thing it exempts", () => {
  // An exemption for a route/event/tool that no longer exists is a stale claim
  // — the same drift the guard exists to stop, one level up.
  const routes = new Set(
    extractRouteHandlers(readRouteFiles()).map((h) => normalizeRoute(h.route)),
  );
  for (const key of Object.keys(API_DOC_EXEMPTIONS)) {
    assert.ok(
      routes.has(key),
      `API_DOC_EXEMPTIONS lists "${key}", which is no longer a route`,
    );
  }
  const events = new Set(
    extractAuditEventTypes(
      readFileSync(join(REPO_ROOT, "packages/web/src/lib/audit.ts"), "utf8"),
    ),
  );
  for (const key of Object.keys(AUDIT_EVENT_DOC_EXEMPTIONS)) {
    assert.ok(
      events.has(key),
      `AUDIT_EVENT_DOC_EXEMPTIONS lists "${key}", no longer an event`,
    );
  }
  const tools = new Set(
    extractGrantableTools(
      readFileSync(
        join(REPO_ROOT, "packages/web/src/lib/tool-registry.ts"),
        "utf8",
      ),
      readPluginManifests(),
    ),
  );
  for (const key of Object.keys(TOOL_DOC_EXEMPTIONS)) {
    assert.ok(
      tools.has(key),
      `TOOL_DOC_EXEMPTIONS lists "${key}", which is no longer a tool`,
    );
  }
});

test("every exemption carries a reason", () => {
  for (const table of [
    API_DOC_EXEMPTIONS,
    AUDIT_EVENT_DOC_EXEMPTIONS,
    TOOL_DOC_EXEMPTIONS,
  ]) {
    for (const [key, reason] of Object.entries(table)) {
      assert.ok(
        typeof reason === "string" && reason.trim().length > 20,
        `exemption "${key}" needs a real reason, got ${JSON.stringify(reason)}`,
      );
    }
  }
});
