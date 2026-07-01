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

type SecretRef = { source: "file"; provider: string; id: string };

function isSecretRef(x: unknown): x is SecretRef {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return o.source === "file" && typeof o.provider === "string" && typeof o.id === "string";
}

function collectSecretRefs(
  node: unknown,
  path: string[],
  out: Array<{ pathDot: string; ref: SecretRef }>
): void {
  if (isSecretRef(node)) {
    out.push({ pathDot: path.join("."), ref: node });
    return;
  }
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectSecretRefs(item, [...path, String(i)], out));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    collectSecretRefs(v, [...path, k], out);
  }
}

function resolveSecretValue(bundle: Record<string, unknown>, slashPath: string): unknown {
  // slashPath like "/providers/openai/apiKey" → ["providers", "openai", "apiKey"]
  const parts = slashPath.split("/").filter(Boolean);
  let cur: unknown = bundle;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function validateBuiltConfig(
  config: unknown,
  secretsBundle?: Record<string, unknown>
): BuiltConfigValidationResult {
  if (!config || typeof config !== "object") return { ok: true };
  const plugins = (config as Record<string, unknown>).plugins as
    { entries?: Record<string, unknown> } | undefined;
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

  // SecretRef drift guard: when the caller passes the secretsBundle that will be
  // written to secrets.json, verify every SecretRef in the config tree resolves
  // to a non-empty value. Catches the class of bug where build.ts emits a
  // pointer (e.g. providers.openai.apiKey) but the bundle for that flow forgot
  // to populate the matching secret. Symptom in production: OpenClaw silently
  // fails at chat time with "No API key found for provider 'openai'".
  if (secretsBundle) {
    const refs: Array<{ pathDot: string; ref: SecretRef }> = [];
    collectSecretRefs(config, [], refs);
    for (const { pathDot, ref } of refs) {
      // Only validate Pinchy's secrets-provider; other providers (e.g. env-based)
      // resolve outside the bundle.
      if (ref.provider !== "pinchy") continue;
      const value = resolveSecretValue(secretsBundle, ref.id);
      if (value === undefined || value === null || value === "") {
        errors.push(
          `secretref at ${pathDot} points to "${ref.id}" but no matching entry exists in secretsBundle (or value is empty)`
        );
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
