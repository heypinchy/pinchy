// Upload-id recovery for history-rebuilt user turns (#1195).
//
// A retry re-sends the message's `attachmentIds` so the agent is handed the
// files again instead of the text alone. Those ids live in the client's
// message state — which does not survive a reload, and the retry affordance
// does: `ChatErrorBanner` asks the server for the session's last un-resolved
// agent error on mount and offers Retry for it, precisely so an error the live
// bubble lost to a reload is still actionable when the user comes back.
//
// So the ids have to be recoverable from history too, or the reload path
// reproduces the exact production symptom #1195 is about: the message arrives
// a second time with the `<pinchy:attachments>` block gone.
//
// They are recoverable because the block names the file: `parseAttachmentBlock`
// already lifts filename + MIME out of the transcript, and `uploaded_files`
// holds the id for `(agentId, userId, filename)` — the shape
// `idx_uploaded_files_lookup` is built on. Filenames are unique within an
// agent workspace by construction (`persistStagedUpload` reserves
// `uploads/<name>` with O_CREAT|O_EXCL and suffixes collisions), so the
// mapping is one-to-one for anything that reservation scheme produced.

/** One file chip on a history turn, as `fetchAndParseHistory` builds it. */
export interface HistoryFileMeta {
  filename: string;
  mimeType: string;
  /** Resolved by `indexUploadIdsByFilename` below; absent when unresolvable. */
  uploadId?: string;
}

interface HistoryTurn {
  role: "user" | "assistant";
  files?: HistoryFileMeta[];
}

/**
 * Every distinct filename a USER turn carries a chip for — the lookup keys for
 * the `uploaded_files` query.
 *
 * User turns only: an assistant turn's chips come from `agent_delivered_files`
 * (agent → user deliveries, re-attached separately) and have no upload row, so
 * including them would query for names that cannot match and, worse, could
 * collide with an upload of the same name and stamp an id onto a turn that can
 * never be retried.
 */
export function collectAttachmentFilenames(messages: HistoryTurn[]): string[] {
  const names = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const file of msg.files ?? []) names.add(file.filename);
  }
  return [...names];
}

/**
 * Build the filename → upload-id index, dropping any filename that more than
 * one row claims.
 *
 * An ambiguous name yields NO id rather than an arbitrary one. The reservation
 * scheme makes duplicates impossible for anything it produced, but rows that
 * predate it (or arrive by some future path) must not be guessed at: a wrong
 * id would re-send a different file under the right name, which is a silent
 * wrong answer — strictly worse than the degraded behaviour of re-sending the
 * text alone, which is what an absent id falls back to.
 */
export function indexUploadIdsByFilename(
  rows: Array<{ id: string; filename: string }>
): Map<string, string> {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (index.has(row.filename)) {
      ambiguous.add(row.filename);
      continue;
    }
    index.set(row.filename, row.id);
  }
  for (const filename of ambiguous) index.delete(filename);
  return index;
}

/**
 * Stamp the resolved upload id onto each user turn's file chips.
 *
 * Returns a shallow copy; only the turns that receive an id are cloned, so
 * referential equality holds for everything untouched — same contract as
 * `attachDeliveredFilesToHistory`, which runs right after this.
 */
export function attachUploadIdsToHistory<T extends HistoryTurn>(
  messages: T[],
  idsByFilename: Map<string, string>
): T[] {
  if (idsByFilename.size === 0) return messages;

  return messages.map((msg) => {
    if (msg.role !== "user" || !msg.files || msg.files.length === 0) return msg;
    let changed = false;
    const resolved = msg.files.map((file) => {
      const uploadId = idsByFilename.get(file.filename);
      if (uploadId === undefined) return file;
      changed = true;
      return { ...file, uploadId };
    });
    if (!changed) return msg;
    return { ...msg, files: resolved };
  });
}
