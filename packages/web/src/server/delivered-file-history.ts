// Agent → user file-delivery history re-attachment (#703).
//
// When a Pinchy plugin hands a file to the user, client-router polls OpenClaw's
// native `artifacts.list` RPC after the run and records a per-user delivery grant
// in the agent_delivered_files table. The grant table is the source of truth.
//
// Delivered files are NOT recoverable from the transcript on reload: OpenClaw's
// chat.history returns only user/assistant/system roles, so the tool artifact
// that carried the file is gone from the reload view. The grant table is the
// durable record instead. This maps each grant back onto the assistant turn it
// was delivered during, so the file chip reappears after a reload.

interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
  files?: Array<{ filename: string; mimeType: string }>;
  timestamp?: number;
}

interface DeliveredGrant {
  filename: string;
  mimeType: string;
  /** Epoch ms the grant was recorded (the delivery moment). */
  createdAt: number;
}

/**
 * Attach each delivered-file grant to the assistant turn that was active when it
 * was delivered — the assistant message with the greatest timestamp `<=`
 * `grant.createdAt`. A grant that predates every turn falls back to the first
 * assistant turn (rather than being dropped). User turns are never targeted, and
 * files already present on a turn (e.g. a user's own upload chips) are preserved.
 *
 * Returns a shallow copy; only the assistant turns that receive a file are
 * cloned, so referential equality holds for everything untouched.
 */
export function attachDeliveredFilesToHistory<T extends HistoryTurn>(
  messages: T[],
  grants: DeliveredGrant[]
): T[] {
  if (grants.length === 0) return messages;

  const assistantIdx = messages
    .map((m, i) => (m.role === "assistant" ? i : -1))
    .filter((i) => i !== -1);
  if (assistantIdx.length === 0) return messages;

  // Accumulate additions per message index so multiple grants merge cleanly.
  const additions = new Map<number, Array<{ filename: string; mimeType: string }>>();
  for (const grant of grants) {
    let target = assistantIdx[0];
    let bestTs = -Infinity;
    for (const i of assistantIdx) {
      const ts = messages[i].timestamp ?? -Infinity;
      if (ts <= grant.createdAt && ts > bestTs) {
        bestTs = ts;
        target = i;
      }
    }
    const list = additions.get(target) ?? [];
    list.push({ filename: grant.filename, mimeType: grant.mimeType });
    additions.set(target, list);
  }

  return messages.map((m, i) => {
    const added = additions.get(i);
    if (!added) return m;
    return { ...m, files: [...(m.files ?? []), ...added] };
  });
}
