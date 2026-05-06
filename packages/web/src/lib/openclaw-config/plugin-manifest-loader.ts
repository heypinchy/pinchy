import pinchyFilesManifest from "../../../../plugins/pinchy-files/openclaw.plugin.json";
import pinchyContextManifest from "../../../../plugins/pinchy-context/openclaw.plugin.json";
import pinchyAuditManifest from "../../../../plugins/pinchy-audit/openclaw.plugin.json";
import pinchyDocsManifest from "../../../../plugins/pinchy-docs/openclaw.plugin.json";
import pinchyEmailManifest from "../../../../plugins/pinchy-email/openclaw.plugin.json";
import pinchyOdooManifest from "../../../../plugins/pinchy-odoo/openclaw.plugin.json";
import pinchyWebManifest from "../../../../plugins/pinchy-web/openclaw.plugin.json";

export const KNOWN_PINCHY_PLUGINS = [
  "pinchy-files",
  "pinchy-context",
  "pinchy-audit",
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
}

const MANIFESTS: Record<KnownPinchyPlugin, PluginManifest> = {
  "pinchy-files": pinchyFilesManifest as unknown as PluginManifest,
  "pinchy-context": pinchyContextManifest as unknown as PluginManifest,
  "pinchy-audit": pinchyAuditManifest as unknown as PluginManifest,
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
