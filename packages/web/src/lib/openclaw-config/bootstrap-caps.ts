// Issue #373: OpenClaw's prompt-bootstrap embedding (pi-embedded-helpers in
// openclaw@2026.5.x) caps each embedded bootstrap file — notably the agent's own
// AGENTS.md — at DEFAULT_BOOTSTRAP_MAX_CHARS (12_000) chars, and the combined
// total at DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS (60_000). When a file exceeds the
// cap, OpenClaw replaces its middle with a truncation marker
// ("[...truncated, read AGENTS.md for full content...]" / a policy digest /
// "…(truncated AGENTS.md: kept …)…"). That has two failure modes for Pinchy:
//
//   1. The agent silently operates on truncated instructions — the dropped
//      middle of its AGENTS.md never reaches the model, and Pinchy deliberately
//      does NOT expose AGENTS.md as a readable path (build.ts keeps SOUL.md /
//      AGENTS.md / IDENTITY.md out of the agent's allowed paths), so OpenClaw's
//      "read AGENTS.md for full content" escape hatch does not work here.
//   2. When the user asks the agent to reproduce its own instructions, the model
//      echoes the literal truncation marker into chat output (the customer's
//      reported `…truncated…` substring).
//
// OpenClaw exposes a per-agent override (`agents.<id>.bootstrapMaxChars` /
// `bootstrapTotalMaxChars`, checked before `agents.defaults.*` — so it avoids the
// agents.defaults hot-reload race of openclaw#47458). Pinchy sizes these to the
// agent's actual bootstrap files so the auto-injection stays complete, up to a
// generous ceiling that protects the context budget.

/** OpenClaw's built-in default per-file bootstrap cap (DEFAULT_BOOTSTRAP_MAX_CHARS). */
export const OPENCLAW_DEFAULT_BOOTSTRAP_MAX_CHARS = 12_000;
/** OpenClaw's built-in default combined bootstrap cap (DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS). */
export const OPENCLAW_DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 60_000;
/**
 * Upper bound for a single embedded bootstrap file (~16k tokens). Comfortably
 * fits any realistic AGENTS.md/SOUL.md while still protecting the context window
 * from a pathologically large instruction file.
 */
export const BOOTSTRAP_PER_FILE_CEILING_CHARS = 64_000;
/** Upper bound for the combined bootstrap budget (~32k tokens). */
export const BOOTSTRAP_TOTAL_CEILING_CHARS = 128_000;

export interface BootstrapCaps {
  /** Per-agent `bootstrapMaxChars` to emit, or undefined to keep OpenClaw's default. */
  bootstrapMaxChars?: number;
  /** Per-agent `bootstrapTotalMaxChars` to emit, or undefined to keep OpenClaw's default. */
  bootstrapTotalMaxChars?: number;
  /**
   * True when the agent's bootstrap files exceed even the protective ceilings, so
   * OpenClaw will still truncate. Callers should surface a build-time warning.
   */
  oversized: boolean;
}

/**
 * Given the character sizes of an agent's bootstrap files (AGENTS.md, SOUL.md, …),
 * compute the per-agent bootstrap caps needed so OpenClaw injects them in full.
 *
 * Returns `{ oversized: false }` with no caps when the files already fit
 * OpenClaw's defaults — in that case Pinchy emits nothing and OpenClaw keeps its
 * built-in behaviour.
 */
export function resolveBootstrapCaps(fileSizes: number[]): BootstrapCaps {
  const sizes = fileSizes.filter((n) => Number.isFinite(n) && n > 0);
  const largest = sizes.length > 0 ? Math.max(...sizes) : 0;
  const total = sizes.reduce((sum, n) => sum + n, 0);

  const needsPerFile = largest > OPENCLAW_DEFAULT_BOOTSTRAP_MAX_CHARS;
  const needsTotal = total > OPENCLAW_DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS;

  if (!needsPerFile && !needsTotal) {
    return { oversized: false };
  }

  const caps: BootstrapCaps = {
    oversized: largest > BOOTSTRAP_PER_FILE_CEILING_CHARS || total > BOOTSTRAP_TOTAL_CEILING_CHARS,
  };

  if (needsPerFile) {
    caps.bootstrapMaxChars = Math.min(largest, BOOTSTRAP_PER_FILE_CEILING_CHARS);
  }

  // The total budget caps the sum of all bootstrap files AND must never sit below
  // the (possibly raised) per-file budget, or OpenClaw would re-truncate the
  // largest file via the total limit.
  const perFileEffective = caps.bootstrapMaxChars ?? OPENCLAW_DEFAULT_BOOTSTRAP_MAX_CHARS;
  if (
    total > OPENCLAW_DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS ||
    perFileEffective > OPENCLAW_DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS
  ) {
    caps.bootstrapTotalMaxChars = Math.min(
      Math.max(total, perFileEffective),
      BOOTSTRAP_TOTAL_CEILING_CHARS
    );
  }

  return caps;
}
