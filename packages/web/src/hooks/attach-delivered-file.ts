/**
 * Apply an agent → user file-delivery frame (#703) to the message list: attach
 * the delivered file's chip metadata to the assistant message carrying the
 * frame's id, mirroring mergeOrAppendChunk's match-by-id / placeholder-adoption
 * logic so a delivery that lands before the first text chunk still binds to the
 * right bubble instead of spawning a duplicate id (which crashes assistant-ui).
 *
 * Only filename + mimeType are carried; the bytes live in the agent workspace
 * and are fetched over HTTP by the chip component.
 */
interface DeliveredFile {
  id: string;
  filename: string;
  mimeType: string;
}

function addFile<T extends { files?: Array<{ filename: string; mimeType: string }> }>(
  message: T,
  filename: string,
  mimeType: string
): T {
  const existing = message.files ?? [];
  // A repeated frame (e.g. a reconnect replay) must not double the chip.
  if (existing.some((f) => f.filename === filename)) return message;
  return { ...message, files: [...existing, { filename, mimeType }] };
}

export function attachDeliveredFile<
  T extends {
    id: string;
    role: string;
    content: string;
    error?: unknown;
    files?: Array<{ filename: string; mimeType: string }>;
  },
>(messages: T[], incoming: DeliveredFile): T[] {
  const { id, filename, mimeType } = incoming;

  // A message with this id already exists — attach in place wherever it sits.
  const existingIdx = messages.findIndex((m) => m.role === "assistant" && m.id === id);
  if (existingIdx !== -1) {
    const updated = messages.slice();
    updated[existingIdx] = addFile(updated[existingIdx], filename, mimeType);
    return updated;
  }

  // Placeholder adoption: a trailing empty assistant placeholder (local id, no
  // error) is the in-flight bubble the send path appended. Adopt its slot with
  // the server id + the file, exactly as the first text chunk would.
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.content === "" && !last.error) {
    const adopted = addFile({ ...last, id }, filename, mimeType);
    return [...messages.slice(0, -1), adopted];
  }

  // Nothing to attach to — append a new content-less assistant message that
  // carries only the file chip.
  return [
    ...messages,
    { id, role: "assistant", content: "", files: [{ filename, mimeType }] } as unknown as T,
  ];
}
