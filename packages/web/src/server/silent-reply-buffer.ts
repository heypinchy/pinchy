// OpenClaw emits this sentinel when the agent decides to stay silent for a
// turn. Streaming can split it across chunks (the user-reported screenshot
// showed "NO_REPL" leaking into the chat UI before the trailing "Y"
// arrived), so callers buffer any suffix that could still complete the
// token and only emit text once we know it can't.
export const SILENT_REPLY_TOKEN = "NO_REPLY";

// Patterns whose trailing prefixes must be held back so split sequences
// across chunk boundaries can either complete (and be stripped/suppressed)
// or be proven to be unrelated text (and emitted). Order is irrelevant —
// the algorithm picks the longest hold across all patterns.
const HOLDBACK_PATTERNS = [SILENT_REPLY_TOKEN, "<final>", "</final>"] as const;

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
