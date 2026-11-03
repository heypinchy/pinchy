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
  extractUpgradeMigrationNotes,
  findGhostEndpoints,
  findMigrationNoteDrift,
  findUndocumentedAuditEvents,
  findUndocumentedEndpoints,
  findUndocumentedTools,
  normalizeRoute,
} from "./docs-coverage.mjs";
import { openNextUpgradeSection } from "./release-logic.mjs";

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

test("findGhostEndpoints names the methods that path really serves", () => {
  // The audit's headline finding: a whole section documenting a `PUT` that was
  // never a route, while the real POST/DELETE were documented too — so the
  // code → docs direction stayed green.
  const problems = findGhostEndpoints(
    [{ route: "/api/settings/domain", methods: ["GET", "POST", "DELETE"] }],
    new Set([
      "GET /api/settings/domain",
      "PUT /api/settings/domain",
      "POST /api/settings/domain",
      "DELETE /api/settings/domain",
    ]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /PUT \/api\/settings\/domain/);
  assert.match(problems[0], /served by DELETE, GET, POST/);
});

test("findGhostEndpoints says so when no handler serves the path at all", () => {
  const problems = findGhostEndpoints(
    [{ route: "/api/setup/provider", methods: ["POST"] }],
    new Set(["POST /api/settings/providers"]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no route handler serves that path at all/);
});

test("findGhostEndpoints is quiet when the docs match the handlers", () => {
  assert.deepEqual(
    findGhostEndpoints(
      [{ route: "/api/agents/[id]", methods: ["GET", "DELETE"] }],
      new Set(["GET /api/agents/{}", "DELETE /api/agents/{}"]),
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

test("extractAuditEventTypes reads a member with more than two segments", () => {
  // A two-segment-only pattern dropped all three `file.upload.*` events, and
  // the corpus floor was satisfied by the survivors — 61 of 64, checked in
  // silence.
  assert.deepEqual(
    extractAuditEventTypes(
      'export type AuditEventType =\n | "file.upload.staged"\n | "agent.created";',
    ),
    ["agent.created", "file.upload.staged"],
  );
});

test("extractAuditEventTypes throws on a member it cannot read", () => {
  // The failure mode this guards is a SHORT list that reads like a complete
  // one, so an unrecognised member must be an error, never a silent omission.
  assert.throws(
    () =>
      extractAuditEventTypes(
        'export type AuditEventType =\n | "agent.created"\n | "Agent.Renamed";',
      ),
    /Agent\.Renamed/,
  );
});

test("extractAuditEventTypes fails loudly when the union moves", () => {
  assert.throws(
    () => extractAuditEventTypes("export type Something = string;"),
    /AuditEventType/,
  );
});

test("findUndocumentedAuditEvents does not accept a longer event as the shorter one", () => {
  // `mdx.includes` would read the page's mention of `user.invite_blocked` as
  // documentation of `user.invite`.
  const problems = findUndocumentedAuditEvents(
    ["user.invite"],
    "| `user.invite_blocked` | An invite was refused. |",
    {},
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /user\.invite/);
});

test("findUndocumentedTools does not accept a longer tool name as the shorter one", () => {
  assert.equal(
    findUndocumentedTools(["odoo_read"], "`odoo_read_group` reads groups.", {})
      .length,
    1,
  );
  assert.deepEqual(
    findUndocumentedTools(["odoo_read"], "`odoo_read` reads records.", {}),
    [],
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

const UPGRADING = (migrations) => `## Standard upgrade

Pull and restart.

## Upgrading from v1.1.0 to %%PINCHY_VERSION%%

### Upgrade notes

#### Something changed

Prose that names \`0007\` in passing.

### Database migrations

The migrations ${migrations}

- \`0005\` — a table, built on the release branch's own \`0003\`.
- \`0006\`, \`0007\` — two columns.

## Upgrading from v1.0.0 to v1.1.0

### Database migrations

- \`0004\` — older.
`;

test("extractUpgradeMigrationNotes reads the newest section's range and the migrations its bullets name", () => {
  assert.deepEqual(
    extractUpgradeMigrationNotes(
      UPGRADING("`0005`–`0007` run automatically on startup."),
    ),
    {
      section: "Upgrading from v1.1.0 to %%PINCHY_VERSION%%",
      from: "0005",
      to: "0007",
      listed: ["0005", "0006", "0007"],
    },
  );
});

test("extractUpgradeMigrationNotes throws when the range cannot be read", () => {
  // A sentence rewritten so the range no longer parses must not read as a
  // section with nothing to check.
  assert.throws(
    () => extractUpgradeMigrationNotes(UPGRADING("run automatically.")),
    /range/,
  );
});

test("extractUpgradeMigrationNotes throws when a bullet names no migration", () => {
  assert.throws(
    () =>
      extractUpgradeMigrationNotes(
        UPGRADING("`0005`–`0007` run.").replace(
          "- `0006`, `0007` — two columns.",
          "- 0006 and 0007 — two columns.",
        ),
      ),
    /0006 and 0007/,
  );
});

test("findMigrationNoteDrift names a migration the list stops short of", () => {
  const notes = extractUpgradeMigrationNotes(
    UPGRADING("`0005`–`0007` run automatically on startup."),
  );
  const journal = ["0004_a", "0005_b", "0006_c", "0007_d", "0008_e"];
  assert.deepEqual(findMigrationNoteDrift(notes, journal), [
    'the newest migration is 0008, but "Upgrading from v1.1.0 to %%PINCHY_VERSION%%" ' +
      "says its migrations end at 0007 — extend the range in docs/src/content/docs/guides/upgrading.mdx",
    'migration 0008 (0008_e) has no bullet under "Upgrading from v1.1.0 to %%PINCHY_VERSION%%" → Database migrations in docs/src/content/docs/guides/upgrading.mdx',
  ]);
});

test("findMigrationNoteDrift names a bullet for a migration the range or the journal does not hold", () => {
  const notes = extractUpgradeMigrationNotes(
    UPGRADING("`0006`–`0007` run automatically on startup."),
  );
  assert.deepEqual(
    findMigrationNoteDrift(notes, ["0005_b", "0006_c", "0007_d"]),
    [
      'docs/src/content/docs/guides/upgrading.mdx lists migration 0005 under "Upgrading from v1.1.0 to %%PINCHY_VERSION%%", outside its range 0006–0007',
    ],
  );
});

test("findMigrationNoteDrift is quiet when the list matches the journal", () => {
  const notes = extractUpgradeMigrationNotes(
    UPGRADING("`0005`–`0007` run automatically on startup."),
  );
  assert.deepEqual(
    findMigrationNoteDrift(notes, ["0004_a", "0005_b", "0006_c", "0007_d"]),
    [],
  );
});

// What `pnpm release v1.2.0` leaves behind: the section it froze, and above it
// the skeleton it opened for the next cycle.
const AFTER_RELEASE = openNextUpgradeSection(
  UPGRADING("`0005`–`0007` run automatically on startup.").replace(
    "%%PINCHY_VERSION%%",
    "v1.2.0",
  ),
  "1.1.0",
  "1.2.0",
);

test("findMigrationNoteDrift sends a migration after a release to the open section, not the released one", () => {
  // The released section is immutable; the only correct home for the next
  // migration is the section the release opened, which has no migration list
  // of its own yet.
  const notes = extractUpgradeMigrationNotes(AFTER_RELEASE);
  assert.deepEqual(
    findMigrationNoteDrift(notes, ["0005_b", "0006_c", "0007_d", "0008_e"]),
    [
      'migration 0008 (0008_e) runs after "Upgrading from v1.1.0 to v1.2.0", but ' +
        '"Upgrading from v1.2.0 to %%PINCHY_VERSION%%" has no Database migrations — ' +
        "add a `### Database migrations` subsection to it in docs/src/content/docs/guides/upgrading.mdx",
    ],
  );
});

test("findMigrationNoteDrift is quiet about an open section with no migrations to list", () => {
  const notes = extractUpgradeMigrationNotes(AFTER_RELEASE);
  assert.deepEqual(
    findMigrationNoteDrift(notes, ["0005_b", "0006_c", "0007_d"]),
    [],
  );
});

test("extractUpgradeMigrationNotes reads a single migration as a range of one", () => {
  const mdx = AFTER_RELEASE.replace(
    "## Upgrading from v1.1.0 to v1.2.0",
    "### Database migrations\n\nThe migration `0008` runs automatically on startup.\n\n" +
      "- `0008` — one column.\n\n## Upgrading from v1.1.0 to v1.2.0",
  );
  const notes = extractUpgradeMigrationNotes(mdx);
  assert.deepEqual(notes, {
    section: "Upgrading from v1.2.0 to %%PINCHY_VERSION%%",
    from: "0008",
    to: "0008",
    listed: ["0008"],
  });
  assert.deepEqual(
    findMigrationNoteDrift(notes, ["0006_c", "0007_d", "0008_e"]),
    [],
  );
});

test("extractUpgradeMigrationNotes does not end a section at a heading quoted in a code fence", () => {
  const mdx = UPGRADING("`0005`–`0007` run automatically on startup.").replace(
    "### Database migrations",
    "```markdown\n## Document Access\n```\n\n### Database migrations",
  );
  assert.equal(
    extractUpgradeMigrationNotes(mdx).section,
    "Upgrading from v1.1.0 to %%PINCHY_VERSION%%",
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

test("the API reference documents no endpoint that does not exist", () => {
  // The other direction, and the one the audit's worst finding lived in: a
  // documented endpoint sends a reader off to write against something that
  // isn't there, and the code → docs check above cannot see it.
  const handlers = extractRouteHandlers(readRouteFiles());
  assert.ok(
    handlers.length > 50,
    `expected the full route set, found ${handlers.length}`,
  );
  const documented = extractDocumentedEndpoints(
    readFileSync(join(DOCS, "reference/api.mdx"), "utf8"),
  );
  assert.ok(
    documented.size > 50,
    `expected the full documented set, found ${documented.size}`,
  );
  assert.deepEqual(findGhostEndpoints(handlers, documented), []);
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

test("the newest upgrade notes list every database migration it runs", () => {
  const journal = JSON.parse(
    readFileSync(
      join(REPO_ROOT, "packages/web/drizzle/meta/_journal.json"),
      "utf8",
    ),
  ).entries.map((entry) => entry.tag);
  assert.ok(
    journal.length > 50,
    `expected the full migration journal, found ${journal.length}`,
  );
  const notes = extractUpgradeMigrationNotes(
    readFileSync(join(DOCS, "guides/upgrading.mdx"), "utf8"),
  );
  // The open section of a new cycle may list one migration, or none yet; a
  // list that is short of the journal is findMigrationNoteDrift's to report.
  // What must hold is that the reader found a list to compare against.
  if ("missing" in notes) {
    assert.match(notes.previous.to, /^\d{4}$/);
  } else {
    assert.ok(
      notes.listed.length > 0,
      `expected the newest section's list, found ${notes.listed.length}`,
    );
  }
  assert.deepEqual(findMigrationNoteDrift(notes, journal), []);
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
