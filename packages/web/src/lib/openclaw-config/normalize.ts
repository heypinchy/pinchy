import { readFileSync } from "fs";
import { isDeepStrictEqual } from "node:util";
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
 *
 * Equality is via `isDeepStrictEqual` so key order doesn't matter — Pinchy
 * builds its payload with one object-literal order and OC's `config.get()`
 * returns a config it serialized in another, so a string-equality check
 * (the previous implementation) reported "differ" on payloads that OC's
 * own `diffConfigPaths` (tree-walking) sees as identical (`changedPaths=
 * <none>`). When that gap exists the no-op-apply guard in write.ts can't
 * fire, the wasted apply still consumes a slot in OC 5.3's ~3-per-45 s
 * config.apply rate-limit, and the next legitimate apply (e.g. enabling
 * Telegram or creating an agent in the same window) comes back with
 * "rate limit exceeded for config.apply; retry after Ns".
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
    return isDeepStrictEqual(pa, pb);
  } catch {
    return false;
  }
}

const isPinchyPlugin = (id: string) => id.startsWith("pinchy-");

/**
 * Deep-supplement: recursively add keys from `source` that are absent from
 * `target`. For keys present in both where both values are plain objects,
 * recurse. Where either side is a scalar/array, the `target` value wins
 * (payload is authoritative for its own keys).
 * Returns true if any change was made to `target`.
 */
function deepSupplement(target: Record<string, unknown>, source: Record<string, unknown>): boolean {
  let changed = false;
  for (const [k, v] of Object.entries(source)) {
    if (!(k in target)) {
      target[k] = v;
      changed = true;
    } else if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      target[k] !== null &&
      typeof target[k] === "object" &&
      !Array.isArray(target[k])
    ) {
      // Both sides are plain objects — recurse to fill missing nested keys.
      if (deepSupplement(target[k] as Record<string, unknown>, v as Record<string, unknown>)) {
        changed = true;
      }
    }
    // else: target already has the key and at least one side is a scalar or
    // array — payload value wins, nothing to do.
  }
  return changed;
}

/**
 * Core supplement logic — merges OpenClaw-auto-configured fields from `source`
 * into `payload`. `source` is either the parsed file content or the parsed
 * OC in-memory config returned by `config.get()`.
 *
 * Fields supplemented (source wins only for keys absent from payload):
 *   - `meta`: entire block (absent when readExistingConfig returned {} during a cold start
 *     — ENOENT or parse error; EACCES is no longer a {}-return path, it throws since #314)
 *   - `plugins.allow`: non-pinchy-* entries appended at end
 *   - `plugins.entries.*`: non-pinchy-* entries not already in payload
 *   - `gateway.controlUi.*`: fields not already in payload gateway.controlUi
 *   - `discovery`, `update`, `canvasHost`: deep-supplemented (OC 5.x enriches
 *     these sections with runtime state; missing subfields → config-reloader
 *     diff → ConfigMutationConflictError on in-process restart)
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

    // Supplement channels: add source fields absent from payload.
    // OC 4.27+ writes additional fields to channels.telegram in-memory (beyond
    // what Pinchy emits). OC 2026.5.x also adds sibling sub-blocks like
    // `channels.defaults` (heartbeat-visibility, botLoopProtection). Without
    // supplementing both layers, config.apply sees a channels diff and triggers
    // a full gateway restart for agents-only changes (channels has no entry in
    // BASE_RELOAD_RULES → fallback is restart-class).
    const payloadChannels = payloadObj.channels as Record<string, unknown> | undefined;
    const sourceChannels = source.channels as Record<string, unknown> | undefined;
    if (payloadChannels && sourceChannels) {
      // (a) Sibling channel sub-blocks (`defaults`, `modelByChannel`, other
      //     channels' configs that OC enriched at runtime). Add anything in
      //     source that the payload doesn't define yet.
      for (const [k, v] of Object.entries(sourceChannels)) {
        if (!(k in payloadChannels)) {
          payloadChannels[k] = v;
          changed = true;
        }
      }
      // (b) Within telegram, merge OC-enriched fields (pollingMode, allowFrom,
      //     etc.) that Pinchy's regenerate didn't write.
      if (payloadChannels.telegram && sourceChannels.telegram) {
        const payloadTelegram = payloadChannels.telegram as Record<string, unknown>;
        const sourceTelegram = sourceChannels.telegram as Record<string, unknown>;
        for (const [k, v] of Object.entries(sourceTelegram)) {
          if (!(k in payloadTelegram)) {
            payloadTelegram[k] = v;
            changed = true;
          }
        }
      }
    }

    // Supplement discovery, update, canvasHost: OC 5.x enriches these sections
    // with runtime state (lastAnnouncedAt, lastCheckedAt, boundPort, peers …).
    // config.apply writes the payload to the file; the config reloader then
    // diffs OC's enriched currentCompareConfig against the new file content.
    // Missing subfields trigger a restart (BASE_RELOAD_RULES_TAIL classifies
    // `gateway`, `discovery`, `canvasHost` as kind:"restart"; `update` has no
    // rule and defaults to restart). On OC 5.3, the in-process SIGUSR1 path
    // then hits ConfigMutationConflictError because startupConfigSnapshotRead
    // is stale. Deep-supplement preserves OC-enriched subfields while keeping
    // Pinchy-owned values (mdns.mode, checkOnStart, enabled) authoritative.
    for (const section of ["discovery", "update", "canvasHost"] as const) {
      const sourceSection = source[section] as Record<string, unknown> | undefined;
      if (sourceSection) {
        const payloadSection = payloadObj[section] as Record<string, unknown> | undefined;
        if (payloadSection) {
          if (deepSupplement(payloadSection, sourceSection)) {
            changed = true;
          }
        } else {
          // Section not in payload at all — add the whole OC block as-is.
          payloadObj[section] = sourceSection;
          changed = true;
        }
      }
    }

    // Supplement models.providers.* baseUrl from the in-memory source if missing in
    // the payload — guards against any path that builds a payload without baseUrl
    // (e.g. targeted partial writes). The primary write path now always emits
    // baseUrl (see build.ts BUILTIN_PROVIDER_DEFAULT_BASE_URLS), so this is
    // defense-in-depth rather than the main fix.
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
