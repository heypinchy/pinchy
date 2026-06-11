/**
 * Apply a streaming content chunk to the message list: merge it into the
 * assistant message that already carries the chunk's id, or append a new
 * assistant message if none exists.
 *
 * The match is by id ANYWHERE in the list, not just the trailing message. The
 * old "only look at the last message" logic appended a second message with the
 * same id whenever the in-flight assistant message wasn't last — which happens
 * on streaming-resume: after a reload the relabeled in-flight message can sit
 * before a trailing user/history message. Two messages with the same id crash
 * assistant-ui's MessageRepository (and the whole chat view). Merging by id
 * makes that duplicate impossible at its source.
 *
 * `incoming.content` is the delta: it is concatenated onto an existing message,
 * or used as the initial content of an appended one.
 */
export function mergeOrAppendChunk<
  T extends { id: string; role: string; content: string; error?: unknown },
>(messages: T[], incoming: T): T[] {
  // Fast path: the common case streams into the trailing assistant message.
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.id === incoming.id) {
    return [...messages.slice(0, -1), { ...last, content: last.content + incoming.content }];
  }

  // Resume path: a message with this id already exists but isn't last — merge
  // into it in place rather than appending a duplicate id.
  const existingIdx = messages.findIndex((m) => m.role === "assistant" && m.id === incoming.id);
  if (existingIdx !== -1) {
    const updated = messages.slice();
    updated[existingIdx] = {
      ...updated[existingIdx],
      content: updated[existingIdx].content + incoming.content,
    };
    return updated;
  }

  // Placeholder adoption: the send path appends an empty in-flight assistant
  // placeholder (local id) so the list always ends in an assistant while a run
  // is in flight. The first chunk carries the server's messageId, which the
  // client could not know at send time — adopt the placeholder (id + content)
  // instead of appending a second bubble. Empty ERROR bubbles also have
  // content "", so the no-error guard keeps them untouched.
  if (last && last.role === "assistant" && last.content === "" && !last.error) {
    // Spread `incoming` over the placeholder so fresh fields (id, content,
    // timestamp) win while any placeholder-only metadata survives.
    return [...messages.slice(0, -1), { ...last, ...incoming }];
  }

  return [...messages, incoming];
}
