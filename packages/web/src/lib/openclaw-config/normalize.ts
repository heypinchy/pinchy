import { readFileSync } from "fs";
import { CONFIG_PATH } from "./paths";

// Workarounds for openclaw#75534 — see #193 for the cascade these prevent and
// #215 for the removal plan once the upstream OpenClaw fix lands. When the
// upstream fix is in our base image, this whole file can be deleted: drop the
// imports + early-return calls in `build.ts` and `write.ts`, then remove this
// module. Behaviour is byte-for-byte identical to the pre-split version.

/**
 * Compare two openclaw.json strings for semantic equivalence, ignoring
 * fields that OpenClaw stamps onto the file independently of any user
 * change. Used to short-circuit redundant config writes / config.apply
 * RPCs that would otherwise trigger spurious gateway restarts via
 * openclaw#75534. See call site for full rationale and removal tracking.
 *
 * Currently normalized: `meta.lastTouchedAt` (a write-time timestamp).
 * Add other OpenClaw-managed metadata fields here if they ever surface.
 */
export function configsAreEquivalentUpToOpenClawMetadata(a: string, b: string): boolean {
  try {
    const pa = JSON.parse(a) as Record<string, unknown>;
    const pb = JSON.parse(b) as Record<string, unknown>;
    const stripMeta = (cfg: Record<string, unknown>) => {
      const meta = cfg.meta as Record<string, unknown> | undefined;
      if (!meta) return;
      delete meta.lastTouchedAt;
      // If meta becomes empty after stripping, remove it entirely so an
      // absent-meta config (cold start) compares equal to a meta-with-only-
      // lastTouchedAt config (post-OpenClaw-stamp).
      if (Object.keys(meta).length === 0) delete cfg.meta;
    };
    stripMeta(pa);
    stripMeta(pb);
    return JSON.stringify(pa) === JSON.stringify(pb);
  } catch {
    return false;
  }
}

// OpenClaw's redacted-value sentinel. When OpenClaw sees this string in
// `env.<KEY>` (or any other registered redactable path) inside an incoming
// config.apply payload, it restores the corresponding value from
// snapshot.config before running the change-paths diff. We rely on this
// to avoid openclaw#75534's spurious env.* restart trigger: Pinchy sends
// the sentinel for env keys whose template hasn't changed, OpenClaw
// substitutes the resolved snapshot value, diffConfigPaths finds no env
// diff, no restart.
//
// Defined in OpenClaw's `runtime-schema-*.js` as
//   const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
// Stable since 2026.4.x. Removable when openclaw#75534 lands; tracked in #215.
export const OPENCLAW_REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

/**
 * Replace `env.<KEY>` values with OpenClaw's redacted sentinel for keys
 * whose template form is unchanged from `existingContent`. New env keys
 * (not present in existing) keep their template form — they represent a
 * legitimate configuration change and the restart they trigger is valid.
 *
 * On cold start (no existing file), returns the input unchanged.
 *
 * This is the workaround for openclaw#75534: see comment on the sentinel
 * constant above. Removable when upstream lands the writer-level fix.
 */
const isPinchyPlugin = (id: string) => id.startsWith("pinchy-");

/**
 * Core supplement logic — merges OpenClaw-auto-configured fields from `source`
 * into `payload`. `source` is either the parsed file content or the parsed
 * OC in-memory config returned by `config.get()`.
 *
 * Fields supplemented (source wins only for keys absent from payload):
 *   - `meta`: entire block (absent when readExistingConfig returns {} on EACCES)
 *   - `plugins.allow`: non-pinchy-* entries appended at end
 *   - `plugins.entries.*`: non-pinchy-* entries not already in payload
 *   - `gateway.controlUi.*`: fields not already in payload gateway.controlUi
 *
 * Pinchy-owned fields are NEVER overwritten — payload is the source of truth.
 */
function supplementFromSource(payload: string, source: Record<string, unknown>): string {
  try {
    const payloadObj = JSON.parse(payload) as Record<string, unknown>;
    let changed = false;

    // Supplement meta: prevents OpenClaw's missing-meta-before-write anomaly
    // that triggers the inotify diff cascade (env, plugins, channels all appear
    // changed because baseline comparison fails without meta present).
    if (!("meta" in payloadObj) && "meta" in source) {
      payloadObj.meta = source.meta;
      changed = true;
    }

    const payloadPlugins = (payloadObj.plugins as Record<string, unknown>) ?? {};
    const sourcePlugins = (source.plugins as Record<string, unknown>) ?? {};

    // Supplement plugins.allow: append non-pinchy source entries not in payload
    const payloadAllow = (payloadPlugins.allow as string[]) ?? [];
    const sourceAllow = (sourcePlugins.allow as string[]) ?? [];
    const payloadAllowSet = new Set(payloadAllow);
    const toAdd = sourceAllow.filter((p) => !isPinchyPlugin(p) && !payloadAllowSet.has(p));
    if (toAdd.length > 0) {
      payloadPlugins.allow = [...payloadAllow, ...toAdd];
      payloadObj.plugins = payloadPlugins;
      changed = true;
    }

    // Supplement plugins.entries: add non-pinchy source entries absent from payload
    const payloadEntries = (payloadPlugins.entries as Record<string, unknown>) ?? {};
    const sourceEntries = (sourcePlugins.entries as Record<string, unknown>) ?? {};
    for (const [id, entry] of Object.entries(sourceEntries)) {
      if (!isPinchyPlugin(id) && !(id in payloadEntries)) {
        payloadEntries[id] = entry;
        payloadPlugins.entries = payloadEntries;
        payloadObj.plugins = payloadPlugins;
        changed = true;
      }
    }

    // Supplement gateway.controlUi: add source fields absent from payload
    const payloadGateway = (payloadObj.gateway as Record<string, unknown>) ?? {};
    const sourceGateway = (source.gateway as Record<string, unknown>) ?? {};
    const sourceControlUi = sourceGateway.controlUi as Record<string, unknown> | undefined;
    if (sourceControlUi) {
      const payloadControlUi = (payloadGateway.controlUi as Record<string, unknown>) ?? {};
      for (const [k, v] of Object.entries(sourceControlUi)) {
        if (!(k in payloadControlUi)) {
          payloadControlUi[k] = v;
          payloadGateway.controlUi = payloadControlUi;
          payloadObj.gateway = payloadGateway;
          changed = true;
        }
      }
    }

    return changed ? JSON.stringify(payloadObj, null, 2) : payload;
  } catch {
    return payload;
  }
}

/**
 * Supplement using OpenClaw's in-memory config returned by `config.get()`.
 * Preferred over `supplementPayloadWithFileFields` because the in-memory state
 * is always up-to-date — no file-write race conditions after a restart.
 */
export function supplementPayloadWithOcConfig(
  payload: string,
  ocConfig: Record<string, unknown>
): string {
  return supplementFromSource(payload, ocConfig);
}

/**
 * Supplement using the current file on disk. Fallback when the OC in-memory
 * config is unavailable (e.g. no WS client configured).
 */
export function supplementPayloadWithFileFields(payload: string): string {
  let fileContent: string;
  try {
    fileContent = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    return payload;
  }
  try {
    const fileObj = JSON.parse(fileContent) as Record<string, unknown>;
    return supplementFromSource(payload, fileObj);
  } catch {
    return payload;
  }
}

export function redactUnchangedEnvForApply(newContent: string): string {
  let existingContent: string;
  try {
    existingContent = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    return newContent;
  }
  try {
    const newCfg = JSON.parse(newContent) as Record<string, unknown>;
    const existingCfg = JSON.parse(existingContent) as Record<string, unknown>;
    const newEnv = (newCfg.env as Record<string, string>) ?? {};
    const existingEnv = (existingCfg.env as Record<string, string>) ?? {};
    const redactedEnv: Record<string, string> = {};
    for (const [key, val] of Object.entries(newEnv)) {
      if (key in existingEnv) {
        // Key is already known to OpenClaw (possibly as a resolved value after
        // OpenClaw expanded "${ENV_VAR}" → "sk-ant-..."). Send the sentinel so
        // OpenClaw restores its current resolved value and diffConfigPaths sees
        // no env change — preventing the spurious env.* restart (openclaw#75534).
        redactedEnv[key] = OPENCLAW_REDACTED_SENTINEL;
      } else {
        redactedEnv[key] = val;
      }
    }
    if (Object.keys(redactedEnv).length === 0 && !("env" in newCfg)) {
      return newContent;
    }
    newCfg.env = redactedEnv;
    return JSON.stringify(newCfg, null, 2);
  } catch {
    return newContent;
  }
}
