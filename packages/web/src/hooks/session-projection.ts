import { uuid } from "@/lib/uuid";
import type { WsFileMeta } from "@/hooks/use-ws-runtime";

/**
 * A chat message in the client's projection of the gateway transcript.
 *
 * "Session is the source of truth": the rendered list is a deterministic
 * projection of transcript events. Each transcript message carries a monotonic
 * `seq` from the gateway — that, not the local `id`, is the identity used to
 * place and reconcile messages. The `id` stays stable across snapshots so
 * assistant-ui keeps its per-message state (and never sees a duplicate id).
 *
 * This is a structural subset of {@link WsMessage}: every field here is shaped
 * the same so a `ProjectedMessage` can flow into the existing runtime without a
 * translation layer.
 */
export interface ProjectedMessage {
  /** Monotonic gateway sequence number — the projection identity. */
  seq: number;
  /** Stable client id, preserved across snapshots for the same `seq`. */
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Non-image attachments shown as chips next to the user message. */
  files?: WsFileMeta[];
  /** ISO timestamp from the transcript, when present. */
  timestamp?: string;
}

/** Authoritative full text of one transcript message, keyed by `seq`. */
export interface MessageSnapshot {
  seq: number;
  role: "user" | "assistant";
  content: string;
  files?: WsFileMeta[];
  timestamp?: string;
}

/** Word-for-word streaming update for the in-flight assistant message. */
export interface TextDelta {
  seq: number;
  text: string;
  /** When true, replace the message content instead of appending to it. */
  replace?: boolean;
}

/**
 * Insert `message` into `messages` keeping ascending `seq` order. Assumes the
 * input is already sorted (the projection only ever grows through these two
 * functions, so the invariant holds). Returns a new array.
 */
function insertBySeq(messages: ProjectedMessage[], message: ProjectedMessage): ProjectedMessage[] {
  const idx = messages.findIndex((m) => m.seq > message.seq);
  if (idx === -1) return [...messages, message];
  return [...messages.slice(0, idx), message, ...messages.slice(idx)];
}

/**
 * Apply an authoritative message snapshot to the projection.
 *
 * Snapshots are the source of truth and are idempotent: applying the same
 * snapshot twice yields an equal list. If a message with the snapshot's `seq`
 * already exists it is replaced in place (preserving its stable `id`), otherwise
 * the snapshot is inserted keeping ascending `seq` order. Returns a new array;
 * the input is never mutated.
 */
export function applyMessageSnapshot(
  messages: ProjectedMessage[],
  snapshot: MessageSnapshot
): ProjectedMessage[] {
  const existingIdx = messages.findIndex((m) => m.seq === snapshot.seq);
  if (existingIdx !== -1) {
    const updated = messages.slice();
    // Preserve the existing id so assistant-ui keeps per-message state; replace
    // every other field from the authoritative snapshot.
    updated[existingIdx] = { ...snapshot, id: messages[existingIdx].id };
    return updated;
  }
  return insertBySeq(messages, { ...snapshot, id: uuid() });
}

/**
 * Apply a streaming text delta for the message at `delta.seq`.
 *
 * Deltas are an optimization for smooth typing between snapshots — a missed
 * delta is self-corrected by the next snapshot. If a message with that `seq`
 * exists, its content is appended to (or replaced when `replace` is set),
 * preserving its `id`. If none exists yet — a delta can arrive before its first
 * snapshot — a new assistant message is created at that `seq`, in order.
 * Returns a new array; the input is never mutated.
 */
export function applyTextDelta(messages: ProjectedMessage[], delta: TextDelta): ProjectedMessage[] {
  const existingIdx = messages.findIndex((m) => m.seq === delta.seq);
  if (existingIdx !== -1) {
    const existing = messages[existingIdx];
    const updated = messages.slice();
    updated[existingIdx] = {
      ...existing,
      content: delta.replace ? delta.text : existing.content + delta.text,
    };
    return updated;
  }
  return insertBySeq(messages, {
    seq: delta.seq,
    id: uuid(),
    role: "assistant",
    content: delta.text,
  });
}
