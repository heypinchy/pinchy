/**
 * `@/lib/agent-granted-paths` with the boundary MOVED to the OS temp dir.
 *
 * Route tests that serve real files build their fixtures under `tmpdir()`, which
 * is not under /data, so the real accessor would (correctly) treat every grant
 * they configure as a pre-lockdown leftover (#1272). Those tests are about what
 * the route does WITH a grant, so they move the boundary rather than switch it
 * off — the same thing they already do for `FILE_SERVE_ROOTS`. The real rule is
 * covered by `lib/agent-granted-paths.test.ts`, and through the workspace-file
 * route by `agent-workspace-file-legacy-grant.test.ts`.
 *
 * Use as `vi.mock("@/lib/agent-granted-paths", () => import("@/test-helpers/granted-paths-under-tmpdir"))`.
 */
import { tmpdir } from "node:os";

import type { AgentPluginConfig } from "@/db/schema";

const ROOT = tmpdir().replace(/\/+$/, "") + "/";

function under(p: unknown): p is string {
  return typeof p === "string" && p.startsWith(ROOT) && !p.split("/").includes("..");
}

function stored(pluginConfig: AgentPluginConfig | null | undefined): unknown[] {
  const paths = pluginConfig?.["pinchy-files"]?.allowed_paths;
  return Array.isArray(paths) ? paths : [];
}

export function grantedDataPaths(pluginConfig: AgentPluginConfig | null | undefined): string[] {
  return stored(pluginConfig).filter(under);
}

export function ungrantablePaths(pluginConfig: AgentPluginConfig | null | undefined): unknown[] {
  return stored(pluginConfig).filter((p) => !under(p));
}
