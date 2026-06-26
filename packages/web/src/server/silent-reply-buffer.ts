// OpenClaw emits this sentinel when the agent decides to stay silent for a
// turn. Streaming can split it across chunks (the user-reported screenshot
// showed "NO_REPL" leaking into the chat UI before the trailing "Y"
// arrived), so callers buffer any suffix that could still complete the
// token and only emit text once we know it can't.
export const SILENT_REPLY_TOKEN = "NO_REPLY";

// Harmony / channel control tokens some models emit around their internal
// reasoning channels (e.g. `<|channel|>analysis<|message|>…`). They are NOT
// meant for the user. When they leak the chat shows a raw "<channel|>" marker —
// the 2026-06 incident where a tool-starved agent slipped into channel mode and
// the delimiter surfaced as its whole reply. We strip them defensively at ingest
// so no model's internal control output can reach the transcript, whatever the
// provider. The single-pipe `<channel|>` is the exact variant observed; the
// double-pipe forms are canonical harmony.
export const CONTROL_TOKENS = [
  "<|channel|>",
  "<|message|>",
  "<|start|>",
  "<|end|>",
  "<|return|>",
  "<|constrain|>",
  "<channel|>",
] as const;

// Patterns whose trailing prefixes must be held back so split sequences
// across chunk boundaries can either complete (and be stripped/suppressed)
// or be proven to be unrelated text (and emitted). Order is irrelevant —
// the algorithm picks the longest hold across all patterns. Control tokens are
// included so a split marker (e.g. `<chan` then `nel|>`) is never half-emitted.
const HOLDBACK_PATTERNS = [SILENT_REPLY_TOKEN, "<final>", "</final>", ...CONTROL_TOKENS] as const;

/**
 * Returns the number of leading characters in `buffer` that are safe to emit
 * without risk of leaking a partial pattern (silent-reply sentinel or
 * `<final>` envelope tag). The remaining suffix — whatever could still grow
 * into one of the patterns — is held back for the next chunk or
 * end-of-turn decision.
 */
export function safeEmitLength(buffer: string): number {
  let longestHold = 0;
  for (const pattern of HOLDBACK_PATTERNS) {
    const max = Math.min(buffer.length, pattern.length);
    for (let suffixLen = max; suffixLen > longestHold; suffixLen--) {
      if (pattern.startsWith(buffer.slice(-suffixLen))) {
        longestHold = suffixLen;
        break;
      }
    }
  }
  return buffer.length - longestHold;
}

/**
 * Strips OpenClaw's `<final>...</final>` envelope from a buffered string.
 * Operates on the full buffer so tags assembled from multiple chunks (e.g.
 * `<fina` then `l>...`) are stripped once the buffer has both halves —
 * `safeEmitLength` retains the leading `<fin…` until the closing `>`
 * arrives, at which point this regex fires.
 */
export function stripFinalEnvelope(buffer: string): string {
  return buffer.replace(/<\/?final>/g, "");
}

// Matches canonical harmony double-pipe tokens (`<|channel|>`, `<|message|>`,
// any `<|…|>`) plus the single-pipe `<channel|>` variant observed in the wild.
// The `[^<>|]*` keeps each match to one token so it can't span real text.
const CONTROL_TOKEN_RE = /<\|[^<>|]*\|>|<channel\|>/g;

/**
 * Strips model control/channel markers from a buffered string. Belt-and-braces
 * for the transcript: OpenClaw should resolve channels itself, but if a marker
 * leaks (a tool-starved or misbehaving model), the user must never see raw
 * `<channel|>` / `<|channel|>` tokens. Operates on the full buffer so markers
 * assembled from multiple chunks are removed once both halves have arrived
 * (`safeEmitLength` holds the leading partial back until then).
 */
export function stripControlTokens(buffer: string): string {
  return buffer.replace(CONTROL_TOKEN_RE, "");
}
