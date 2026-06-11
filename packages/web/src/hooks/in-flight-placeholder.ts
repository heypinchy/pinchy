/**
 * In-flight assistant placeholder helpers (the tab-refocus crash fix).
 *
 * assistant-ui injects an OPTIMISTIC assistant message while
 * `isRunning && last.role !== "assistant"` — and removes it again on any
 * `isRunning → false` transition. That removal shrinks the rendered count by
 * one; a trailing-index subscriber reading its stale snapshot then crashes
 * the view with `tapClientLookup: Index N out of bounds (length: N)`
 * (production incident on v0.5.7: backgrounded tab → ws close flips
 * isRunning without message compensation → boundary visible on refocus).
 *
 * Instead of guarding every isRunning flip, Pinchy appends its OWN empty
 * in-flight assistant placeholder at send time — the list then always ends
 * in an assistant while running, the optimistic message never exists, and
 * every isRunning transition is count-neutral. These helpers keep the
 * placeholder's lifecycle consistent:
 *
 * - the first chunk ADOPTS it (see mergeOrAppendChunk),
 * - terminal bubbles (timeout/disconnect/error) REPLACE it instead of
 *   appending next to it,
 * - history-length comparisons IGNORE it (it never exists server-side).
 */

interface PlaceholderShape {
  role: string;
  content: string;
  error?: unknown;
}

export function isInFlightPlaceholder(msg: PlaceholderShape | undefined): boolean {
  return !!msg && msg.role === "assistant" && msg.content === "" && !msg.error;
}

/**
 * Replace a trailing placeholder with `bubble` (count-neutral), or append the
 * bubble when nothing adoptable trails.
 */
export function replaceTrailingPlaceholder<T extends PlaceholderShape>(
  messages: T[],
  bubble: T
): T[] {
  if (isInFlightPlaceholder(messages[messages.length - 1])) {
    return [...messages.slice(0, -1), bubble];
  }
  return [...messages, bubble];
}

/**
 * Drop a trailing placeholder for comparisons against server history — the
 * placeholder is a client-only artifact the server never knows about.
 */
export function stripTrailingPlaceholder<T extends PlaceholderShape>(messages: T[]): T[] {
  if (isInFlightPlaceholder(messages[messages.length - 1])) {
    return messages.slice(0, -1);
  }
  return messages;
}
