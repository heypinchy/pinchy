import type { AgentPluginConfig } from "@/db/schema";

/** How one folder-grant list moved: counts only, never the paths. */
export type FolderGrantDiff = { added: number; removed: number; count: number };

export type FolderAccessDiff = { read: FolderGrantDiff; write: FolderGrantDiff };

/**
 * `pluginConfig` as an audit row may show it. Identical to the stored config
 * except that `pinchy-files` carries how many folders are granted instead of
 * which ones.
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
 * So the grant lists become counts in the from/to view, and the edit itself
 * is recorded as added/removed counts (`folderAccess`). The diff is what makes
 * a swap visible: replacing one folder with another leaves the count — and
 * therefore the redacted from/to — unchanged.
 *
 * Every other plugin's config passes through untouched. Comparison is by
 * set, so reordering the same folders records nothing.
 */
export function pluginConfigAuditChange(
  from: AgentPluginConfig | null,
  to: AgentPluginConfig | null
): PluginConfigAuditChange {
  const result: PluginConfigAuditChange = {};

  const fromView = auditView(from);
  const toView = auditView(to);
  if (JSON.stringify(fromView) !== JSON.stringify(toView)) {
    result.change = { from: fromView, to: toView };
  }

  const read = grantDiff(
    from?.["pinchy-files"]?.allowed_paths,
    to?.["pinchy-files"]?.allowed_paths
  );
  const write = grantDiff(from?.["pinchy-files"]?.write_paths, to?.["pinchy-files"]?.write_paths);
  if (read.added + read.removed + write.added + write.removed > 0) {
    result.folderAccess = { read, write };
  }

  return result;
}

function auditView(config: AgentPluginConfig | null): PluginConfigAuditView | null {
  if (!config) return null;
  const { "pinchy-files": files, ...rest } = config;
  if (!files) return rest;
  // Field by field, not a spread with the lists deleted: a field
  // pinchy-files grows later (another path list) must be a decision to log,
  // not something that lands on a signed row by default.
  return {
    "pinchy-files": {
      allowedPathCount: new Set(files.allowed_paths ?? []).size,
      writePathCount: new Set(files.write_paths ?? []).size,
      ...(files.allowed_extensions !== undefined
        ? { allowed_extensions: files.allowed_extensions }
        : {}),
    },
    ...rest,
  };
}

function grantDiff(before: string[] | undefined, after: string[] | undefined): FolderGrantDiff {
  const old = new Set(before ?? []);
  const next = new Set(after ?? []);
  return {
    added: [...next].filter((p) => !old.has(p)).length,
    removed: [...old].filter((p) => !next.has(p)).length,
    count: next.size,
  };
}
