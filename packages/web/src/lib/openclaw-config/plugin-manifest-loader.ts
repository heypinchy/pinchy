import pinchyFilesManifest from "../../../../plugins/pinchy-files/openclaw.plugin.json";
import pinchyContextManifest from "../../../../plugins/pinchy-context/openclaw.plugin.json";
import pinchyAuditManifest from "../../../../plugins/pinchy-audit/openclaw.plugin.json";
import pinchyTranscriptManifest from "../../../../plugins/pinchy-transcript/openclaw.plugin.json";
import pinchyDocsManifest from "../../../../plugins/pinchy-docs/openclaw.plugin.json";
import pinchyEmailManifest from "../../../../plugins/pinchy-email/openclaw.plugin.json";
import pinchyOdooManifest from "../../../../plugins/pinchy-odoo/openclaw.plugin.json";
import pinchyWebManifest from "../../../../plugins/pinchy-web/openclaw.plugin.json";

export const KNOWN_PINCHY_PLUGINS = [
  "pinchy-files",
  "pinchy-context",
  "pinchy-audit",
  "pinchy-transcript",
  "pinchy-docs",
  "pinchy-email",
  "pinchy-odoo",
  "pinchy-web",
] as const;

export type KnownPinchyPlugin = (typeof KNOWN_PINCHY_PLUGINS)[number];

export const EXTERNAL_INTEGRATION_PLUGINS = [
  "pinchy-web",
  "pinchy-email",
  "pinchy-odoo",
] as const satisfies readonly KnownPinchyPlugin[];

export const INTERNAL_PLUGINS = [
  "pinchy-files",
  "pinchy-context",
  "pinchy-docs",
  "pinchy-audit",
  "pinchy-transcript",
] as const satisfies readonly KnownPinchyPlugin[];

// Compile-time exhaustiveness check: every known plugin must appear in exactly
// one of the two buckets above. If a new plugin is added to KNOWN_PINCHY_PLUGINS
// without a classification, this assignment fails to type-check.
type _ExhaustiveCheck =
  | (typeof EXTERNAL_INTEGRATION_PLUGINS)[number]
  | (typeof INTERNAL_PLUGINS)[number];
const _assertCovers: KnownPinchyPlugin extends _ExhaustiveCheck
  ? _ExhaustiveCheck extends KnownPinchyPlugin
    ? true
    : never
  : never = true;
void _assertCovers;

export interface PluginManifest {
  id: KnownPinchyPlugin;
  name: string;
  description?: string;
  configSchema: Record<string, unknown>;
  contracts?: { tools?: string[] };
}

const MANIFESTS: Record<KnownPinchyPlugin, PluginManifest> = {
  "pinchy-files": pinchyFilesManifest as unknown as PluginManifest,
  "pinchy-context": pinchyContextManifest as unknown as PluginManifest,
  "pinchy-audit": pinchyAuditManifest as unknown as PluginManifest,
  "pinchy-transcript": pinchyTranscriptManifest as unknown as PluginManifest,
  "pinchy-docs": pinchyDocsManifest as unknown as PluginManifest,
  "pinchy-email": pinchyEmailManifest as unknown as PluginManifest,
  "pinchy-odoo": pinchyOdooManifest as unknown as PluginManifest,
  "pinchy-web": pinchyWebManifest as unknown as PluginManifest,
};

export function loadPluginManifest(id: KnownPinchyPlugin): PluginManifest {
  const manifest = MANIFESTS[id];
  if (!manifest) {
    throw new Error(`Unknown Pinchy plugin id: ${id}`);
  }
  return manifest;
}

/**
 * The union of every tool name declared by a Pinchy plugin manifest
 * (`contracts.tools`), deduplicated and sorted. This is the source of truth for
 * the per-agent tool allowlist (see `computeAllowedTools` in tool-registry.ts):
 * because the allowlist is derived from the manifests, adding a tool to a
 * plugin automatically widens the allowlist — no second list to keep in sync.
 * Plugins with no tools (pinchy-audit, pinchy-transcript — hooks only) simply
 * contribute nothing.
 */
export function getAllPinchyPluginToolNames(): string[] {
  const names = new Set<string>();
  for (const id of KNOWN_PINCHY_PLUGINS) {
    for (const tool of MANIFESTS[id].contracts?.tools ?? []) {
      names.add(tool);
    }
  }
  return [...names].sort();
}
