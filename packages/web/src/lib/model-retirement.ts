/**
 * Classify whether an error from an OpenClaw tool/model dispatch indicates the
 * configured model is no longer AVAILABLE upstream (retired / unknown), as
 * opposed to a transient or capability error.
 *
 * Motivation: providers retire models without advance notice (Ollama Cloud
 * documents a deprecation table but no notice window and no RSS/webhook —
 * https://docs.ollama.com/cloud). When a configured model is retired, every
 * dispatch fails the same way (e.g. HTTP 410 "qwen3-vl:235b-instruct was
 * retired"). OpenClaw has no fallback resolver, so Pinchy self-heals: a
 * retired-model error triggers a config regeneration, which re-resolves media
 * models against the live `/v1/models` catalog (see `default-media-models.ts`).
 *
 * We deliberately match AVAILABILITY signals only:
 *   - HTTP 410 ("retired"/"gone")
 *   - "Unknown model" / "model_not_found" / HTTP 404 on a model id
 * and NOT capability errors like 400 "Image input is not enabled for this
 * model" — re-resolving doesn't fix a model that exists but lacks a capability;
 * that's the curated-list's job, not self-heal's.
 */
const RETIREMENT_PATTERNS: readonly RegExp[] = [
  /\b410\b/,
  /\bretired\b/i,
  /\bunknown model\b/i,
  /\bmodel[_ ]not[_ ]found\b/i,
  /\bno longer available\b/i,
];

export function isRetiredModelError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : "";
  if (!message) return false;
  return RETIREMENT_PATTERNS.some((re) => re.test(message));
}
