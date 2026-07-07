import { createHash } from "node:crypto";

/**
 * Handle-indirection for email message/attachment ids (Bug B, 2026-07-07
 * debugging session; sibling of PR #668).
 *
 * Microsoft Graph message ids are ~150-char base64 blobs. Handing the raw id
 * to the model and requiring it to echo it back verbatim on a later turn
 * invites corruption by weaker models (a 32-char internal segment silently
 * dropped on reproduction -> Graph's `ErrorInvalidIdMalformed`). Instead the
 * plugin mints a short, deterministic, per-agent handle and resolves it back
 * to the real id server-side, so the model only ever has to copy ~15
 * characters.
 *
 * Keyed by agentId so one agent can never resolve another agent's handle —
 * tenant isolation is enforced by the map structure itself, not by a runtime
 * check that could be forgotten at a call site.
 *
 * Pure, synchronous, in-memory, no I/O. v1 scope: no DB, no timers — expiry
 * is swept lazily on put(), and a process restart simply means handles must
 * be re-minted by calling email_list / email_search again (the "honest
 * re-list" error path in index.ts covers that case).
 */

export const MSG_PREFIX = "msg";
export const ATT_PREFIX = "att";

const TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Per-agent entry cap. Exported so the tools that mint handles
 * (email_list/email_search) can clamp their result-set size to it: a single
 * result set larger than the cap would evict its own earliest handles as the
 * later ones are minted, leaving the top rows the model was just shown
 * unresolvable (Finding 1, 2026-07-07 review). Keeping every result set at or
 * below the cap makes that impossible.
 */
export const MAX_ENTRIES_PER_AGENT = 500;

// 16 hex chars = 64 bits of a realId's sha256. Short enough that the model can
// still copy it verbatim (a Graph id is ~150 chars), but wide enough that a
// collision between two distinct realIds within an agent's cap is negligible:
// the birthday bound at 500 entries is ~500^2 / 2^65 ≈ 7e-15. An earlier
// 32-bit handle sat at ~3e-5, where a collision would silently overwrite one
// entry and resolve a handle to the WRONG email (Finding 2, 2026-07-07 review).
const HANDLE_HEX_LENGTH = 16;

interface HandleEntry {
  realId: string;
  expiresAt: number;
}

// Insertion-ordered Map lets us evict the oldest entry in O(1) via
// `.keys().next()` when an agent's store exceeds its cap.
type AgentStore = Map<string, HandleEntry>;

const stores = new Map<string, AgentStore>();

/**
 * Derive a short, deterministic handle for a realId. Same realId + prefix
 * always yields the same handle, so repeated email_list calls show the model
 * a stable reference for the same message. Different prefixes namespace
 * message vs. attachment handles so they can never collide with each other.
 */
export function handleFor(realId: string, prefix: string): string {
  const digest = createHash("sha256").update(realId).digest("hex");
  return `${prefix}_${digest.slice(0, HANDLE_HEX_LENGTH)}`;
}

function getOrCreateAgentStore(agentId: string): AgentStore {
  let store = stores.get(agentId);
  if (!store) {
    store = new Map<string, HandleEntry>();
    stores.set(agentId, store);
  }
  return store;
}

/** Remove expired entries from an agent's store. Called lazily on put(). */
function sweepExpired(store: AgentStore, now: number): void {
  for (const [handle, entry] of store) {
    if (entry.expiresAt <= now) store.delete(handle);
  }
}

/** Evict the oldest (earliest-inserted) entries until the store is within cap. */
function enforceCap(store: AgentStore): void {
  while (store.size > MAX_ENTRIES_PER_AGENT) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

/**
 * Mint (or refresh) a handle for realId, scoped to agentId, under the
 * message prefix (MSG_PREFIX). Idempotent: a repeated call with the same
 * realId returns the same handle and refreshes its expiry, so the same email
 * gets the same handle across repeated lists.
 *
 * Use putAttachmentHandle for attachment ids — the prefix must be chosen at
 * the call site (message vs. attachment) so the two id spaces never collide.
 */
export function putHandle(agentId: string, realId: string): string {
  return putWithPrefix(agentId, realId, MSG_PREFIX);
}

/** Same as putHandle, but under the attachment prefix (ATT_PREFIX). */
export function putAttachmentHandle(agentId: string, realId: string): string {
  return putWithPrefix(agentId, realId, ATT_PREFIX);
}

function putWithPrefix(
  agentId: string,
  realId: string,
  prefix: string,
): string {
  const store = getOrCreateAgentStore(agentId);
  const now = Date.now();
  sweepExpired(store, now);

  const handle = handleFor(realId, prefix);
  // Delete-then-set (rather than plain set on an existing key) so the
  // refreshed entry moves to the end of the insertion order — otherwise a
  // frequently-reused handle would look "old" to enforceCap's oldest-first
  // eviction despite being the most recently accessed.
  store.delete(handle);
  store.set(handle, { realId, expiresAt: now + TTL_MS });
  enforceCap(store);
  return handle;
}

/**
 * Resolve a handle back to its realId for a given agent. Returns null if the
 * handle is unknown, expired, or belongs to a different agent (tenant
 * isolation: each agent only ever looks in its own store).
 */
export function resolveHandle(agentId: string, handle: string): string | null {
  const store = stores.get(agentId);
  if (!store) return null;
  const entry = store.get(handle);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(handle);
    return null;
  }
  return entry.realId;
}
