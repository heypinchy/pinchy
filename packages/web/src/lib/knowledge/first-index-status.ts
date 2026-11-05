/**
 * The shape of an agent's first-index status (#1280), apart from the code
 * that computes it: the chat reads this type from a Client Component, and the
 * module that answers it (./first-index.ts) imports the database.
 */
export type FirstIndexStatus =
  /** Nothing to say: the agent's folders are indexed, or it does not search the index. */
  | { state: "none" }
  /** The first index is about to start: queued with nothing ahead of it, or about to be. */
  | { state: "queued" }
  /** Another run holds the instance's one job slot; the first index starts when it finishes. */
  | { state: "waiting" }
  /** The first index is running. `total` is null until discovery has walked every folder. */
  | { state: "indexing"; processed: number; total: number | null };
