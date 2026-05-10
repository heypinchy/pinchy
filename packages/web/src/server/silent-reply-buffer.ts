// OpenClaw emits this sentinel when the agent decides to stay silent for a
// turn. Streaming can split it across chunks (the user-reported screenshot
// showed "NO_REPL" leaking into the chat UI before the trailing "Y"
// arrived), so callers buffer any suffix that could still complete the
// token and only emit text once we know it can't.
export const SILENT_REPLY_TOKEN = "NO_REPLY";

/**
 * Returns the number of leading characters in `buffer` that are safe to emit
 * without risk of leaking a partial SILENT_REPLY_TOKEN. The remaining suffix
 * is whatever could still grow into the sentinel — held back for the next
 * chunk or end-of-turn decision.
 */
export function safeEmitLength(buffer: string): number {
  const max = Math.min(buffer.length, SILENT_REPLY_TOKEN.length);
  for (let suffixLen = max; suffixLen > 0; suffixLen--) {
    if (SILENT_REPLY_TOKEN.startsWith(buffer.slice(-suffixLen))) {
      return buffer.length - suffixLen;
    }
  }
  return buffer.length;
}

/**
 * Strips OpenClaw's `<final>...</final>` envelope from a buffered string.
 * Buffer-level rather than chunk-level so split tags (e.g. `<fina` then
 * `l>...`) get stripped correctly.
 */
export function stripFinalEnvelope(buffer: string): string {
  return buffer.replace(/<\/?final>/g, "");
}
