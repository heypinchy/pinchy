/**
 * The shape of an agent's first-index status (#1280), apart from the code
 * that computes it: the chat reads this type from a Client Component, and the
 * module that answers it (./first-index.ts) imports the database.
 */
export type FirstIndexStatus =
  /** Nothing to say: the agent's folders are indexed, or it does not search the index. */
  | { state: "none" }
  /** The first index is about to start: queued with nothing ahead of it, or about to be. */
  | ({ state: "queued" } & FirstIndexScope)
  /** Another run holds the instance's one job slot; the first index starts when it finishes. */
  | ({ state: "waiting" } & FirstIndexScope)
  /** The first index is running. `total` is null until discovery has walked every folder. */
  | ({ state: "indexing"; processed: number; total: number | null } & FirstIndexScope);

export interface FirstIndexScope {
  /**
   * Some of the agent's folders are indexed already, so it answers from them
   * while only the newly granted ones wait — the chat must not say it can
   * find nothing.
   */
  partial: boolean;
}
