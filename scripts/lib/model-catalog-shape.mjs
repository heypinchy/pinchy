// Pure validator for the vendored models.dev snapshot
// (packages/web/src/lib/model-catalog-snapshot.json). A bad refresh must not
// commit a snapshot OpenClaw's per-agent model-catalog schema would reject —
// that silently drops the whole provider from an agent's effective catalog
// (see openclaw-builtin-models.ts on the required cost fields).
//
// Returns an array of human-readable problem strings; empty means valid.

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];

/**
 * @param {unknown} snapshot Parsed model-catalog-snapshot.json
 * @returns {string[]} problems, empty when the snapshot is valid
 */
export function validateModelCatalogSnapshot(snapshot) {
  const problems = [];

  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return ["snapshot must be a non-null object keyed by model id"];
  }

  const entries = Object.entries(snapshot);
  if (entries.length === 0) {
    problems.push("snapshot is empty — a refresh wrote no models");
  }

  for (const [key, entry] of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${key}: entry must be an object`);
      continue;
    }

    if (typeof entry.contextWindow !== "number" || entry.contextWindow <= 0) {
      problems.push(`${key}: contextWindow must be a number > 0`);
    }

    if (typeof entry.maxTokens !== "number") {
      problems.push(`${key}: maxTokens must be a number`);
    }

    if (!Array.isArray(entry.input) || entry.input.length === 0) {
      problems.push(`${key}: input must be a non-empty array`);
    }

    const cost = entry.cost;
    if (cost === null || typeof cost !== "object" || Array.isArray(cost)) {
      problems.push(`${key}: cost must be an object`);
    } else {
      for (const field of COST_FIELDS) {
        if (typeof cost[field] !== "number") {
          problems.push(`${key}: cost.${field} must be a number`);
        }
      }
    }
  }

  return problems;
}
