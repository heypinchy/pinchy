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
