/**
 * The shape of an agent's first-index status (#1280), apart from the code
 * that computes it: the chat reads this type from a Client Component, and the
 * module that answers it (./first-index.ts) imports the database.
 */
export type FirstIndexStatus =
  /** Nothing to say: the agent's folders are indexed, or it does not search the index. */
  | { state: "none" }
  /** The first index is waiting — for its turn, or behind another agent's run. */
  | { state: "queued" }
  /** The first index is running. `total` is null until discovery has walked every folder. */
  | { state: "indexing"; processed: number; total: number | null };
