// Shared parser for Pinchy's curated Ollama Cloud catalog
// (packages/web/src/lib/ollama-cloud-models.ts).
//
// The discovery, vision-verification, and tool-verification scripts all need
// the same thing: the list of model IDs (and their capability flags) as they
// appear in the source file, without pulling in TypeScript tooling. This
// module is that one parser, covered by ollama-cloud-source.test.mjs so the
// three scripts can trust it instead of each re-implementing a regex.

// Tight allowlist for model IDs as they appear in the curated source file.
// Ollama Cloud IDs use lowercase letters, digits, and the punctuation set
// `[.:_-]` (e.g. `qwen3-vl:235b-instruct`, `gpt-oss:120b`, `deepseek-v3.1:671b`).
// Validating against this pattern at parse time gives any outbound HTTP
// request built from these IDs a guaranteed-safe shape and stops anything
// pathological from flowing from the file into a network sink. CodeQL
// recognises this as a sanitizer for the "file data -> outbound request"
// finding; the verify scripts re-assert it at the sink for good measure.
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.:_-]*$/;

// Per-field extractors use fixed literal regexes (never `new RegExp(...)`):
// a dynamically built RegExp trips CodeQL's js/incomplete-sanitization even
// on harmless literal input, which has cost real CI rounds here before.
function firstNumber(chunk, regex) {
  const m = chunk.match(regex);
  return m ? Number(m[1]) : null;
}

function firstBoolean(chunk, regex) {
  const m = chunk.match(regex);
  return m ? m[1] === "true" : null;
}

/**
 * Parse the `TOOL_CAPABLE_OLLAMA_CLOUD_MODELS` entries out of the source text.
 *
 * @param {string} source - contents of ollama-cloud-models.ts
 * @returns {Array<{id: string, contextWindow: number|null, maxTokens: number|null, reasoning: boolean|null, vision: boolean|null}>}
 */
export function parseOllamaCloudModels(source) {
  // Strip comments first so prose like `id: "foo"` or `vision: true` written
  // inside a comment can never be parsed as a real field. Each replace uses a
  // non-backtracking pattern (no nested quantifiers) — no ReDoS risk.
  const stripped = source
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const idMatches = [...stripped.matchAll(/id:\s*"([^"]+)"/g)];
  if (idMatches.length === 0) {
    throw new Error(
      "parseOllamaCloudModels: no model entries parsed from source",
    );
  }

  const models = [];
  for (let i = 0; i < idMatches.length; i++) {
    const id = idMatches[i][1];
    if (!MODEL_ID_PATTERN.test(id)) {
      throw new Error(
        `parseOllamaCloudModels: parsed model ID "${id}" does not match the safe ID allowlist (${MODEL_ID_PATTERN}). ` +
          "Refusing to use it — fix the source file or widen the pattern deliberately.",
      );
    }
    // Scope the remaining fields to this entry: from this `id:` up to the next
    // `id:` (or end of file). Order-independent within the entry.
    const start = idMatches[i].index;
    const end =
      i + 1 < idMatches.length ? idMatches[i + 1].index : stripped.length;
    const chunk = stripped.slice(start, end);

    models.push({
      id,
      contextWindow: firstNumber(chunk, /contextWindow:\s*(\d+)/),
      maxTokens: firstNumber(chunk, /maxTokens:\s*(\d+)/),
      reasoning: firstBoolean(chunk, /reasoning:\s*(true|false)/),
      vision: firstBoolean(chunk, /vision:\s*(true|false)/),
    });
  }
  return models;
}
