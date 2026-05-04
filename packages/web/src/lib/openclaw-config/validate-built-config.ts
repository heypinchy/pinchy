import { validatePluginEntry } from "./plugin-schema";
import {
  loadPluginManifest,
  KNOWN_PINCHY_PLUGINS,
  type KnownPinchyPlugin,
} from "./plugin-manifest-loader";

const KNOWN = new Set<string>(KNOWN_PINCHY_PLUGINS);

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
    if (!entry || entry.config === undefined) continue;
    const manifest = loadPluginManifest(pluginId as KnownPinchyPlugin);
    const result = validatePluginEntry(manifest, entry.config);
    if (!result.ok) {
      for (const err of result.errors) {
        errors.push(`${pluginId}: ${err}`);
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
