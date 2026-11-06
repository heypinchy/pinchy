import type { AgentPluginConfig } from "@/db/schema";

/** How the agent's granted /data folders moved: counts only, never the paths. */
export type FolderAccessDiff = { added: number; removed: number; count: number };

/**
 * `pluginConfig` as an audit row may show it: every plugin's settings, except
 * that `pinchy-files` says how many folders are granted instead of which ones.
 */
type PluginConfigAuditView = Record<string, unknown>;

export type PluginConfigAuditChange = {
  change?: { from: PluginConfigAuditView | null; to: PluginConfigAuditView | null };
  folderAccess?: FolderAccessDiff;
};

/**
 * What an `agent.updated` row records for a `pluginConfig` edit.
 *
 * Folder paths never go into it. Since subfolder grants (#1269) a path can
 * name a person (`/data/hr/personnel/<name>`), and an audit row is immutable
 * and HMAC-chained, so GDPR erasure cannot rewrite it later (AGENTS.md PII
 * rule — same call as `pathCount` in `knowledge.reindex`). A full path list
 * also pushed `from` + `to` past the 2048-byte detail cap at about twenty
 * grants, and `truncateDetail` then replaces the whole detail, losing what
 * changed.
 *
 * So `allowed_paths` becomes a count in the from/to view, and the edit itself
 * is recorded as added/removed counts (`folderAccess`). The diff is what makes
 * a swap visible: replacing one folder with another leaves the count — and
 * therefore the redacted from/to — unchanged.
 *
 * A stored `write_paths` is left out altogether. It grants nothing —
 * `build.ts` derives write access from the `pinchy_write` / `pinchy_memory`
 * tool grants, which `changes.allowedTools` already records — and the
 * Permissions tab drops it on save, so reporting it would record a revocation
 * that never happened.
 *
 * Comparison is by set for folders and by canonical (key-sorted) JSON for the
 * rest: jsonb hands keys back in its own order, and the same config must not
 * read as a change.
 */
export function pluginConfigAuditChange(
  from: AgentPluginConfig | null,
  to: AgentPluginConfig | null
): PluginConfigAuditChange {
  const result: PluginConfigAuditChange = {};

  const fromView = auditView(from);
  const toView = auditView(to);
  if (canonicalJson(fromView) !== canonicalJson(toView)) {
    result.change = { from: fromView, to: toView };
  }

  const folders = grantDiff(
    from?.["pinchy-files"]?.allowed_paths,
    to?.["pinchy-files"]?.allowed_paths
  );
  if (folders.added + folders.removed > 0) result.folderAccess = folders;

  return result;
}

/**
 * One entry per plugin key, so a key added to `AgentPluginConfig` fails to
 * compile here until someone decides how it is logged — the alternative is
 * whatever it carries landing on a signed row by default.
 */
const VIEW_BY_PLUGIN: {
  [K in keyof Required<AgentPluginConfig>]: (value: NonNullable<AgentPluginConfig[K]>) => unknown;
} = {
  "pinchy-files": (files) => ({
    allowedPathCount: new Set(files.allowed_paths ?? []).size,
    ...(files.allowed_extensions !== undefined
      ? { allowed_extensions: files.allowed_extensions }
      : {}),
  }),
  // Tool, model and domain names — no personal data.
  "pinchy-web": (web) => web,
  "pinchy-approvals": (approvals) => approvals,
};

function auditView(config: AgentPluginConfig | null): PluginConfigAuditView | null {
  if (!config) return null;
  const view: PluginConfigAuditView = {};
  for (const key of Object.keys(VIEW_BY_PLUGIN) as (keyof AgentPluginConfig)[]) {
    const value = config[key];
    if (value === undefined) continue;
    view[key] = (VIEW_BY_PLUGIN[key] as (v: typeof value) => unknown)(value);
  }
  return view;
}

function grantDiff(before: string[] | undefined, after: string[] | undefined): FolderAccessDiff {
  const old = new Set(before ?? []);
  const next = new Set(after ?? []);
  return {
    added: [...next].filter((p) => !old.has(p)).length,
    removed: [...old].filter((p) => !next.has(p)).length,
    count: next.size,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}
