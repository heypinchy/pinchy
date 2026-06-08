/**
 * Collapse items that share an `id`, keeping the LAST occurrence at its
 * position and dropping earlier duplicates.
 *
 * Used as a defense-in-depth guard right before the message list is handed to
 * assistant-ui's `useExternalStoreRuntime`. assistant-ui's MessageRepository
 * throws ("a message with the same id already exists in the parent tree") and
 * crashes the entire chat view via the error boundary if it ever receives two
 * messages with the same id. The streaming-resume reconcile can transiently
 * produce such a duplicate (the in-flight assistant message arrives both from
 * the relabeled history and from the resumed stream); this keeps a duplicate
 * from ever reaching assistant-ui, regardless of reconcile timing.
 *
 * Keeping the last occurrence means the freshest version of a streaming message
 * wins.
 */
export function dedupeById<T extends { id?: string }>(items: T[]): T[] {
  const lastIndexById = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.id !== undefined) lastIndexById.set(item.id, index);
  });
  return items.filter(
    (item, index) => item.id === undefined || lastIndexById.get(item.id) === index
  );
}
