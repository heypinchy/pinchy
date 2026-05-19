import { validatePluginEntry } from "./plugin-schema";
import {
  loadPluginManifest,
  KNOWN_PINCHY_PLUGINS,
  type KnownPinchyPlugin,
} from "./plugin-manifest-loader";

const KNOWN = new Set<string>(KNOWN_PINCHY_PLUGINS);

// Matches a bare workspace root like /root/.openclaw/workspaces/<id>
// but not a subpath like /root/.openclaw/workspaces/<id>/uploads
const WORKSPACE_ROOT_RE = /^\/root\/\.openclaw\/workspaces\/[^/]+$/;

function validatePinchyFilesConfig(pluginConfig: unknown, errors: string[]): void {
  if (!pluginConfig || typeof pluginConfig !== "object") return;
  const cfg = pluginConfig as Record<string, unknown>;
  const agents = cfg.agents;
  if (!agents || typeof agents !== "object") return;

  for (const [agentId, rawAgentCfg] of Object.entries(agents as Record<string, unknown>)) {
    if (!rawAgentCfg || typeof rawAgentCfg !== "object") continue;
    const agentCfg = rawAgentCfg as Record<string, unknown>;

    const allowedPaths = agentCfg.allowed_paths;
    const writePaths = agentCfg.write_paths;

    if (!Array.isArray(writePaths) || writePaths.length === 0) continue;

    const allowedSet = new Set<string>(
      Array.isArray(allowedPaths)
        ? allowedPaths.filter((p): p is string => typeof p === "string")
        : []
    );

    const writePathStrings = writePaths.filter((p): p is string => typeof p === "string");
    for (const wp of writePathStrings) {
      // Invariant 1: write_paths must be a subset of allowed_paths
      if (!allowedSet.has(wp)) {
        errors.push(
          `pinchy-files: agent "${agentId}" write_paths entry "${wp}" is not in allowed_paths — write_paths must be a subset of allowed_paths`
        );
      }

      // Invariant 2: write_paths must not contain the raw workspace root
      if (WORKSPACE_ROOT_RE.test(wp)) {
        errors.push(
          `pinchy-files: agent "${agentId}" write_paths entry "${wp}" is the bare workspace root, which is forbidden — use the /uploads subdirectory instead`
        );
      }
    }
  }
}

export type BuiltConfigValidationResult = { ok: true } | { ok: false; errors: string[] };

export function validateBuiltConfig(config: unknown): BuiltConfigValidationResult {
  if (!config || typeof config !== "object") return { ok: true };
  const plugins = (config as Record<string, unknown>).plugins as
    | { entries?: Record<string, unknown> }
    | undefined;
  const entries = plugins?.entries ?? {};

  const errors: string[] = [];
  for (const [pluginId, rawEntry] of Object.entries(entries)) {
    if (!KNOWN.has(pluginId)) continue;
    const entry = rawEntry as { config?: unknown } | undefined;
    if (!entry) continue;
    // entry.config may be undefined if build.ts accidentally omits the config block.
    // Pass it through to validatePluginEntry — the schema (type: "object", required: [...])
    // will reject it, so the guard catches the regression rather than silently skipping it.
    const manifest = loadPluginManifest(pluginId as KnownPinchyPlugin);
    const result = validatePluginEntry(manifest, entry.config);
    if (!result.ok) {
      for (const err of result.errors) {
        errors.push(`${pluginId}: ${err}`);
      }
    }

    // Extra semantic invariants for pinchy-files
    if (pluginId === "pinchy-files") {
      validatePinchyFilesConfig(entry.config, errors);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
