// Pure set-diff logic for Ollama Cloud model discovery.
//
// `discover-ollama-cloud-models.mjs` fetches the live cloud catalog from
// https://ollama.com/v1/models and compares it against the IDs Pinchy curates
// in ollama-cloud-models.ts. This module is the comparison, kept pure so it is
// testable without the network.

/**
 * @param {string[]} liveIds   - model IDs currently served by ollama.com
 * @param {string[]} curatedIds - model IDs in Pinchy's curated catalog
 * @returns {{ added: string[], removed: string[], present: string[] }}
 *   added   - live but not curated -> candidates a human/agent must triage
 *             (may be chat-only or not tool-capable; never auto-added)
 *   removed - curated but no longer live -> stale entries to drop
 *   present - curated and still live
 */
export function diffModels(liveIds, curatedIds) {
  const live = new Set(liveIds);
  const curated = new Set(curatedIds);

  const added = [...live].filter((id) => !curated.has(id)).sort();
  const removed = [...curated].filter((id) => !live.has(id)).sort();
  const present = [...curated].filter((id) => live.has(id)).sort();

  return { added, removed, present };
}
