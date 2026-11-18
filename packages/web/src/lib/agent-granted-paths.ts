/**
 * The folders an agent's `pinchy-files.allowed_paths` actually grants.
 *
 * Since v0.9.0 every writer of that column confines it to the data root
 * (`pluginConfigSchema`, domain-validation.ts). Rows written before then were
 * never rewritten, and the old PATCH let a member point their own agent
 * anywhere — the workspaces root, which holds every other agent's uploads,
 * workbench and MEMORY.md, among them (#1272). A stored entry outside /data is
 * therefore not a grant, and every reader of the column goes through
 * `grantedDataPaths` so none of them can treat it as one. The boot-time
 * cleanup (`stripUngrantablePaths`) removes such entries from the rows and
 * audits each removal; this read-side filter is what holds regardless of
 * whether that cleanup has run.
 *
 * Type-only import plus `citation-path.ts`, which itself imports nothing, so
 * this module is safe on both sides of the client/server bundle boundary.
 */
import type { AgentPluginConfig } from "@/db/schema";
import { isPathUnderDataRoot } from "./knowledge/citation-path";

function storedPaths(pluginConfig: AgentPluginConfig | null | undefined): unknown[] {
  const paths = pluginConfig?.["pinchy-files"]?.allowed_paths;
  // jsonb is not checked against the type: a malformed row reads as nothing
  // granted rather than throwing inside the config build.
  return Array.isArray(paths) ? paths : [];
}

/** The stored entries under the data root, in their stored order. */
export function grantedDataPaths(pluginConfig: AgentPluginConfig | null | undefined): string[] {
  return storedPaths(pluginConfig).filter(isPathUnderDataRoot);
}

/** The stored entries `grantedDataPaths` drops — what a pre-lockdown row still carries. */
export function ungrantablePaths(pluginConfig: AgentPluginConfig | null | undefined): unknown[] {
  return storedPaths(pluginConfig).filter((p) => !isPathUnderDataRoot(p));
}

/**
 * The audit actor of the boot cleanup (`stripUngrantablePaths`), so its rows
 * read apart from other `system` writers. Kept here, in an import-free module,
 * so the audit trail's label map can name it without pulling in the database.
 */
export const ALLOWED_PATHS_CLEANUP_ACTOR = "allowed-paths-cleanup";
