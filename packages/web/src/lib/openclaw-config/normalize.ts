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
