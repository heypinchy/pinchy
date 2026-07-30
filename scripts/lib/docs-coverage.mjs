/**
 * Drift guards for the three hand-maintained lists in `docs/` that mirror a
 * machine-derivable truth in the code (#1002).
 *
 * The 2026-07-30 post-release docs audit found the same defect three times, in
 * three different files, all invisible to CI:
 *
 *   - `reference/api.mdx` documented 60 of 96 API routes. Three whole feature
 *     families shipped without an entry (Automations, OpenAI-compatible
 *     providers, IMAP).
 *   - `concepts/audit-trail.mdx` listed 47 of 56 audit event types. The three
 *     missing knowledge-base events are the ones the KB guide points AT that
 *     page to find.
 *   - `concepts/agent-permissions.mdx` — the canonical "what can an agent do"
 *     page — never mentioned `knowledge_search`, the tool behind the release's
 *     headline feature.
 *
 * The control group is the reason this file exists: `contracts.tools` did NOT
 * drift, because `manifest-tools-drift.test.ts` guards it. The one list with a
 * guard is the one list that stayed correct. A list a human must remember to
 * update is a list that will be wrong; the fix is not more diligence, it is a
 * diff.
 *
 * All three checks live in ONE module on purpose. They are the same operation
 * — extract identifiers from code, assert each appears in a doc — and splitting
 * them would triple the fixture boilerplate while making the shared
 * normalization (route params, exemption tables) drift instead.
 *
 * Everything here is pure: callers pass file contents in, the sibling
 * `docs-coverage.test.mjs` reads the real repo and asserts against it, and
 * `pnpm test:scripts` runs it in CI's `quality` job. No new CI wiring.
 */

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

/**
 * Endpoints deliberately absent from `reference/api.mdx`, each with the reason
 * it is not part of the documented HTTP surface. An entry here is a claim that
 * no reader ever needs it — not "we did not get round to it".
 *
 * Keys are normalized routes (see `normalizeRoute`), values the reason.
 */
export const API_DOC_EXEMPTIONS = {
  "/api/auth/{}":
    "Better Auth catch-all — the library owns this surface, documented upstream",
  "/api/dev/enterprise-toggle":
    "development-only helper, not present in a production build",
  "/api/internal/openclaw-config-ready":
    "gateway↔web handshake on the container network; no client outside OpenClaw may call it",
  "/api/internal/audit/tool-use":
    "gateway-only audit ingress, authed by the bootstrap gateway token",
  "/api/internal/audit/background-run":
    "gateway-only audit ingress for non-request agent runs",
  "/api/internal/usage/record":
    "gateway-only usage ingress, mirrors internal/audit/*",
  "/api/internal/channel-messages": "gateway-only channel-capture ingress",
  "/api/internal/settings/context":
    "gateway-only context read for the pinchy-context plugin",
  "/api/internal/users/{}/context":
    "gateway-only per-user context read for the pinchy-context plugin",
};

/**
 * Audit event types deliberately absent from `concepts/audit-trail.mdx`.
 * Keep this empty unless an event is genuinely not observable by an admin.
 */
export const AUDIT_EVENT_DOC_EXEMPTIONS = {};

/**
 * Tools deliberately absent from `concepts/agent-permissions.mdx`.
 *
 * The page documents what an admin can GRANT. A tool that is always on for
 * every agent and carries no permission decision belongs in the pages that
 * explain the feature, not in the permission tables — but it must be named
 * here, so "always on" stays a written decision rather than an omission.
 */
export const TOOL_DOC_EXEMPTIONS = {
  docs_list:
    "always on — Smithers reads the product docs; no permission decision to make",
  docs_read: "always on — see docs_list",
  pinchy_save_user_context:
    "always on — writes the user's own context block, covered in /concepts/context/",
  pinchy_save_org_context: "always on — see pinchy_save_user_context",
  odoo_schema:
    "deprecated alias of odoo_describe_model; documenting it would invite new use",
};

/**
 * Collapses a Next.js route directory path into a comparable shape.
 *
 * Code and docs disagree on parameter NAMES — the handler lives in
 * `app/api/agents/[agentId]/` while the reference documents
 * `GET /api/agents/:id` — and that disagreement is cosmetic. Both sides
 * normalize every parameter to `{}` so the comparison is structural.
 *
 * @param {string} route e.g. "/api/agents/[agentId]/uploads" or "/api/agents/:id"
 * @returns {string} e.g. "/api/agents/{}/uploads"
 */
export function normalizeRoute(route) {
  return route
    .replace(/\[\.\.\.[^\]]+\]/g, "{}") // [...all]
    .replace(/\[[^\]]+\]/g, "{}") // [agentId]
    .replace(/:[A-Za-z0-9_]+/g, "{}") // :agentId
    .replace(/<[^>]+>/g, "{}") // <nameOrSlug> in a documented query value
    .replace(/\/+$/, "");
}

/**
 * @param {Array<{path: string, source: string}>} files route.ts files, `path`
 *   relative to `packages/web/src/app` (e.g. "api/agents/[id]/route.ts")
 * @returns {Array<{route: string, methods: string[]}>} sorted by route
 */
export function extractRouteHandlers(files) {
  const out = [];
  for (const { path, source } of files) {
    const route = "/" + path.replace(/\/route\.ts$/, "");
    // Two shapes ship here: the usual `export async function GET`, and the
    // destructured re-export a library handler needs
    // (`export const { POST, GET } = toNextJsHandler(auth)` in the Better Auth
    // catch-all). Missing the second one would silently drop a route from the
    // set the guard checks — the exact blindness this file exists to remove.
    const destructured = [
      ...source.matchAll(/^export\s+const\s+\{([^}]*)\}\s*=/gm),
    ]
      .flatMap((m) => m[1].split(","))
      .map((s) => s.trim());
    const methods = HTTP_METHODS.filter(
      (m) =>
        new RegExp(
          `^export\\s+(?:async\\s+)?(?:function|const)\\s+${m}\\b`,
          "m",
        ).test(source) || destructured.includes(m),
    );
    if (methods.length > 0) out.push({ route, methods });
  }
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

/**
 * Reads the `### \`GET /api/...\`` headings out of the API reference.
 *
 * A documented endpoint may carry a query string (`?provider=<nameOrSlug>`);
 * the path before `?` is what identifies it.
 *
 * @param {string} mdx contents of reference/api.mdx
 * @returns {Set<string>} entries like "GET /api/agents/{}"
 */
export function extractDocumentedEndpoints(mdx) {
  const set = new Set();
  const re = new RegExp(
    `\\b(${HTTP_METHODS.join("|")})\\s+(/api/[^\\s\`?]*)`,
    "g",
  );
  for (const [, method, path] of mdx.matchAll(re)) {
    set.add(`${method} ${normalizeRoute(path)}`);
  }
  return set;
}

/**
 * @param {Array<{route: string, methods: string[]}>} handlers
 * @param {Set<string>} documented
 * @param {Record<string, string>} [exemptions]
 * @returns {string[]} problems (empty = ok)
 */
export function findUndocumentedEndpoints(
  handlers,
  documented,
  exemptions = API_DOC_EXEMPTIONS,
) {
  const problems = [];
  for (const { route, methods } of handlers) {
    const key = normalizeRoute(route);
    if (key in exemptions) continue;
    const missing = methods.filter((m) => !documented.has(`${m} ${key}`));
    if (missing.length > 0) {
      problems.push(
        `${missing.join(", ")} ${route} is not in docs/src/content/docs/reference/api.mdx ` +
          `(document it, or add it to API_DOC_EXEMPTIONS with a reason)`,
      );
    }
  }
  return problems;
}

/**
 * Pulls the concrete string members out of the `AuditEventType` union.
 *
 * Template members (`` `tool.${string}` ``) are skipped: they are a family, and
 * the reference documents the family as `tool.<toolName>`.
 *
 * @param {string} source contents of packages/web/src/lib/audit.ts
 * @returns {string[]} sorted event types
 */
export function extractAuditEventTypes(source) {
  const union = /export type AuditEventType =([\s\S]*?);/.exec(source);
  if (!union)
    throw new Error("audit.ts: could not find the AuditEventType union");
  const literals = union[1].matchAll(/"([a-z_]+\.[a-z_]+)"/g);
  return [...new Set([...literals].map((m) => m[1]))].sort();
}

/**
 * @param {string[]} eventTypes
 * @param {string} mdx contents of concepts/audit-trail.mdx
 * @param {Record<string, string>} [exemptions]
 * @returns {string[]} problems (empty = ok)
 */
export function findUndocumentedAuditEvents(
  eventTypes,
  mdx,
  exemptions = AUDIT_EVENT_DOC_EXEMPTIONS,
) {
  return eventTypes
    .filter((t) => !(t in exemptions) && !mdx.includes(t))
    .map(
      (t) =>
        `audit event "${t}" is not in docs/src/content/docs/concepts/audit-trail.mdx ` +
        `(document it, or add it to AUDIT_EVENT_DOC_EXEMPTIONS with a reason)`,
    );
}

/**
 * Every tool an agent can be granted, from both sources of truth: the web
 * app's registry (what the Permissions tab renders) and the plugin manifests
 * (what OpenClaw will actually dispatch).
 *
 * Reading BOTH is the point. `knowledge_search` is in no registry — it reaches
 * an agent only through the Knowledge Base template's `allowedTools` — so a
 * registry-only check would have kept missing exactly the tool that went
 * undocumented.
 *
 * @param {string} registrySource contents of packages/web/src/lib/tool-registry.ts
 * @param {Array<{id: string, tools: string[]}>} manifests plugin manifests
 * @returns {string[]} sorted tool ids
 */
export function extractGrantableTools(registrySource, manifests) {
  const ids = new Set(
    [...registrySource.matchAll(/^\s*id:\s*"([a-z_]+)"/gm)].map((m) => m[1]),
  );
  for (const { tools } of manifests) for (const t of tools ?? []) ids.add(t);
  return [...ids].sort();
}

/**
 * @param {string[]} toolIds
 * @param {string} mdx contents of concepts/agent-permissions.mdx
 * @param {Record<string, string>} [exemptions]
 * @returns {string[]} problems (empty = ok)
 */
export function findUndocumentedTools(
  toolIds,
  mdx,
  exemptions = TOOL_DOC_EXEMPTIONS,
) {
  return toolIds
    .filter((t) => !(t in exemptions) && !mdx.includes(t))
    .map(
      (t) =>
        `tool "${t}" is not in docs/src/content/docs/concepts/agent-permissions.mdx ` +
        `(document it, or add it to TOOL_DOC_EXEMPTIONS with a reason)`,
    );
}
