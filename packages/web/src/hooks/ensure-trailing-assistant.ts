/**
 * Anchor an in-flight run's assistant reply as the TRAILING message of the
 * reconciled history, so the list always ends with an assistant while the run
 * is running.
 *
 * Why this matters: assistant-ui's external store appends its own *optimistic*
 * assistant message whenever `isRunning && lastMessage.role !== "assistant"`
 * (see external-store-thread-runtime-core: `hasUpcomingMessage`). That extra
 * message lands in assistant-ui's message COUNT
 * (`ThreadPrimitive.Messages` renders `thread.messages.length` items) one render
 * before its internal per-message resource list catches up — so
 * `aui.thread().message({ index }).getState()` is called with an index one past
 * the resource list and throws `tapClientLookup: Index N out of bounds
 * (length: N)`, which the app's error boundary turns into "Something went
 * wrong". This is the streaming-resume crash that survives the dedupeById /
 * mergeOrAppendChunk guards (#470).
 *
 * On reload mid-stream the server sends history + an `activeRun` signal, but the
 * in-flight assistant reply may not be persisted yet (history ends in the user
 * turn) — exactly the `isRunning && last !== assistant` shape. The `anchor`
 * carries the run id and the server's resume buffer (`partialContent`) as its
 * content. By appending it (or re-anchoring the existing trailing assistant), we
 * keep the list ending in an assistant: assistant-ui never injects its optimistic
 * message, and future streaming chunks MERGE into this id via `mergeOrAppendChunk`
 * instead of appending a fresh bubble (another count lead).
 *
 * Content: when re-anchoring an assistant that's already in history, we adopt
 * whichever is MORE complete — the server's `partialContent` (authoritative,
 * up-to-the-millisecond) or the persisted history content — so a lagging or
 * empty resume buffer can never shrink a reply the user already saw.
 */
export function ensureTrailingAssistant<T extends { id: string; role: string; content: string }>(
  messages: T[],
  anchor: T
): T[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    // The in-flight reply is already trailing — re-anchor its id and adopt the
    // more complete content (resume buffer vs persisted partial).
    const content = anchor.content.length >= last.content.length ? anchor.content : last.content;
    return [...messages.slice(0, -1), { ...last, id: anchor.id, content }];
  }
  // No trailing assistant (unpersisted reply, or a newer user turn trails it):
  // append the anchor so the list ends with an assistant.
  return [...messages, anchor];
}
