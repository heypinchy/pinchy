import { readFileSync } from "fs";
import { CONFIG_PATH } from "./paths";

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

    // Supplement channels.telegram: add source fields absent from payload.
    // OC 4.27+ writes additional fields to channels.telegram in-memory (beyond
    // what Pinchy emits). Without this, config.apply sees a channels diff and
    // triggers a full gateway restart even for agents-only changes.
    const payloadChannels = payloadObj.channels as Record<string, unknown> | undefined;
    const sourceChannels = source.channels as Record<string, unknown> | undefined;
    if (payloadChannels?.telegram && sourceChannels?.telegram) {
      const payloadTelegram = payloadChannels.telegram as Record<string, unknown>;
      const sourceTelegram = sourceChannels.telegram as Record<string, unknown>;
      for (const [k, v] of Object.entries(sourceTelegram)) {
        if (!(k in payloadTelegram)) {
          payloadTelegram[k] = v;
          changed = true;
        }
      }
    }

    // Supplement models.providers.* baseUrl: OC 4.27+ with ANTHROPIC_BASE_URL env var
    // auto-sets baseUrl in its in-memory config. Pinchy's payload only writes apiKey
    // and models — omitting baseUrl. Without supplementing, config.apply fails schema
    // validation: "anthropic.baseUrl: Invalid input: expected string, received undefined".
    const payloadModels = payloadObj.models as Record<string, unknown> | undefined;
    const sourceModels = source.models as Record<string, unknown> | undefined;
    if (payloadModels?.providers && sourceModels?.providers) {
      const payloadProviders = payloadModels.providers as Record<string, unknown>;
      const sourceProviders = sourceModels.providers as Record<string, unknown>;
      for (const [providerId, sourceProvider] of Object.entries(sourceProviders)) {
        const payloadProvider = payloadProviders[providerId];
        if (
          payloadProvider &&
          typeof payloadProvider === "object" &&
          typeof sourceProvider === "object"
        ) {
          const pp = payloadProvider as Record<string, unknown>;
          const sp = sourceProvider as Record<string, unknown>;
          if ("baseUrl" in sp && !("baseUrl" in pp)) {
            pp.baseUrl = sp.baseUrl;
            changed = true;
          }
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
