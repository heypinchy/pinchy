import Ajv, { type ErrorObject } from "ajv";

interface PluginManifest {
  id: string;
  configSchema: Record<string, unknown>;
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

const ajv = new Ajv({ allErrors: true, strict: false });

const compiledByPluginId = new Map<string, ReturnType<typeof ajv.compile>>();

export function validatePluginEntry(manifest: PluginManifest, config: unknown): ValidationResult {
  let validate = compiledByPluginId.get(manifest.id);
  if (!validate) {
    validate = ajv.compile(manifest.configSchema);
    compiledByPluginId.set(manifest.id, validate);
  }
  const ok = validate(config);
  if (ok) return { ok: true };
  return {
    ok: false,
    errors: (validate.errors ?? []).map(formatAjvError),
  };
}

function formatAjvError(err: ErrorObject): string {
  const path = err.instancePath
    ? err.instancePath.replace(/^\//, "").replace(/\//g, ".")
    : "<root>";
  const detail =
    err.params && Object.keys(err.params).length ? ` (${JSON.stringify(err.params)})` : "";
  return `${path}: ${err.message ?? "invalid"}${detail}`;
}
