// Pure helpers for the Ollama Cloud tool-calling probe.
//
// `verify-ollama-cloud-tools.mjs` POSTs a small function-tool request to
// https://ollama.com/v1/chat/completions for each curated model and checks the
// reply. Every model in TOOL_CAPABLE_OLLAMA_CLOUD_MODELS is, by definition,
// expected to emit a *structured* tool_call — a model that silently skips the
// call (qwen3-next's empty-content failure), leaks the call as plain text
// (gemini-3-flash-preview's `default_api` signature), or emits a structurally
// valid call with mangled nested arguments (minimax-m3) must not be surfaced as
// tool-capable, because every Pinchy agent relies on tools (files/context/docs).
//
// These functions are the request shapes and the response classifiers, kept
// pure so the network wrapper stays thin and this logic is unit-tested. There
// are two probes: a flat one (get_weather) and a nested one (search_records),
// and they catch different defect classes — keep both.

// Signatures of a tool call that a model rendered into plain text instead of
// returning a structured `tool_calls` array. `get_weather` is the probe's own
// tool name (see buildToolProbeRequest).
const LEAK_PATTERNS = [
  /default_api[.\s]/i, // gemini-3-flash-preview's leak signature
  /<\/?tool_call>/i, // <tool_call>…</tool_call> blobs
  /<\/?tools>/i, // <tools>…</tools> blobs
  /\bget_weather\s*\(/, // a parenthesised call written as prose
  /\bfunctions?\.\w+/i, // functions.get_weather style
];

/**
 * Build the probe request body for a model id.
 * @param {string} id
 */
export function buildToolProbeRequest(id) {
  return {
    model: id,
    max_tokens: 128,
    tool_choice: "auto",
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city.",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name, e.g. Paris" },
            },
            required: ["city"],
          },
        },
      },
    ],
    messages: [
      {
        role: "user",
        content:
          "What's the current weather in Paris? Use the get_weather tool to find out.",
      },
    ],
  };
}

/**
 * True for HTTP statuses that are infra noise (rate limit / server overload),
 * not a capability verdict. The verify wrapper retries these and, if they
 * persist, reports the model as INCONCLUSIVE rather than drift — a 503
 * "temporarily overloaded" must never be mistaken for "this model lost its
 * tools, remove it." 400/404 (capability error / model gone) are definitive.
 * @param {number} status
 */
export function isTransientStatus(status) {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/**
 * Build the multi-turn follow-up: replay the model's tool_call, then hand it a
 * tool result. A genuinely tool-capable model answers (HTTP 200); gemma3 and
 * kimi-k2-thinking return HTTP 500 once the history carries a tool result,
 * which is the failure mode this round exists to catch.
 * @param {string} id
 * @param {{content?: string, tool_calls: Array<{id: string}>}} assistantMessage - the round-1 message
 */
export function buildToolFollowupRequest(id, assistantMessage) {
  const firstCall = assistantMessage.tool_calls[0];
  return {
    model: id,
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content:
          "What's the current weather in Paris? Use the get_weather tool to find out.",
      },
      {
        role: "assistant",
        content: assistantMessage.content ?? "",
        tool_calls: assistantMessage.tool_calls,
      },
      {
        role: "tool",
        tool_call_id: firstCall.id,
        content: "It is 22°C and sunny in Paris.",
      },
    ],
  };
}

// --- Round 3: nested arguments -------------------------------------------
//
// The flat get_weather probe above only proves a model can fill in one string.
// minimax-m3 passes it cleanly and still mangles NESTED arrays: they collapse
// into {"item": …} objects, and some arrive stringified ("[10, 20]"). On
// 2026-07-15 that broke the production agent "Penny" against Odoo — domain
// filters died with "unhashable type: 'dict'" and account.move
// invoice_line_ids/tax_ids command triplets were rejected (20 of 60 tool calls
// mangled, vs 0/112 on kimi-k2.6 and 0/68 on deepseek-v4-pro). Pinchy's Odoo
// tools are array-of-arrays all the way down, so this round asks for exactly
// that shape and insists the arguments parse back to genuine arrays.

const NESTED_PROBE_PROMPT =
  "Find the posted invoices worth more than 10 EUR. Use the search_records " +
  'tool on the "account.move" model with the filters state = posted and ' +
  "amount > 10, and return the name and amount fields.";

const NESTED_REQUIRED_ARGS = ["model", "filters", "fields"];

const NESTED_TOOL_NAME = "search_records";

// Keys a model wraps a collapsed array in instead of emitting the array.
const ITEM_WRAPPER_KEYS = ["item", "items"];

/**
 * Build the nested-argument probe request for a model id.
 * @param {string} id
 */
export function buildNestedToolProbeRequest(id) {
  return {
    model: id,
    // Roomier than the flat probe's 128: a thinking model spends budget before
    // it emits the call, and a truncated call would read as a defect it hasn't
    // got. The payload itself is ~40 tokens, so the headroom is nearly free.
    max_tokens: 512,
    tool_choice: "auto",
    tools: [
      {
        type: "function",
        function: {
          name: NESTED_TOOL_NAME,
          description: "Search business records with a filter domain.",
          parameters: {
            type: "object",
            properties: {
              model: {
                type: "string",
                description: 'Model name, e.g. "account.move"',
              },
              filters: {
                type: "array",
                description:
                  'A filter domain: a list of [field, operator, value] triplets, e.g. [["state", "=", "posted"], ["amount", ">", 10]].',
                items: {
                  type: "array",
                  description:
                    'One [field, operator, value] triplet, e.g. ["state", "=", "posted"].',
                  items: {},
                },
              },
              fields: {
                type: "array",
                description: 'Field names to return, e.g. ["name", "amount"].',
                items: { type: "string" },
              },
            },
            required: NESTED_REQUIRED_ARGS,
          },
        },
      },
    ],
    messages: [{ role: "user", content: NESTED_PROBE_PROMPT }],
  };
}

const fail = (failure, detail) => ({ nestedOk: false, failure, detail });

// A scalar the model rendered as "[…]" — the array survived the model's head
// but left it as text, so the tool receives a string where a list belongs.
function looksStringified(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

function itemWrapperKey(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return ITEM_WRAPPER_KEYS.find((k) =>
    Object.prototype.hasOwnProperty.call(value, k),
  );
}

// Why `value` is not the array it was asked to be, or null if it is one.
function arrayDefect(value, path) {
  if (Array.isArray(value)) return null;
  if (looksStringified(value)) {
    return fail(
      "stringified-array",
      `${path} arrived as a stringified array: ${JSON.stringify(value)}`,
    );
  }
  const wrapper = itemWrapperKey(value);
  if (wrapper) {
    return fail(
      "item-wrapper",
      `${path} collapsed into a {"${wrapper}": …} wrapper object instead of an array`,
    );
  }
  return fail(
    "wrong-shape",
    `${path} arrived as ${typeof value}, expected an array`,
  );
}

// Why `value` is not the scalar a domain triplet holds, or null if it is one.
// A triplet's third member may legitimately be a list — ["state", "in",
// ["posted", "draft"]] is a valid domain — so lists are checked, not rejected.
function scalarDefect(value, path) {
  if (looksStringified(value)) {
    return fail(
      "stringified-array",
      `${path} arrived as a stringified array: ${value}`,
    );
  }
  if (value === null || typeof value !== "object") return null;
  const wrapper = itemWrapperKey(value);
  if (wrapper) {
    return fail(
      "item-wrapper",
      `${path} collapsed into a {"${wrapper}": …} wrapper object`,
    );
  }
  if (!Array.isArray(value)) {
    return fail(
      "wrong-shape",
      `${path} arrived as an object, expected a scalar`,
    );
  }
  for (const [i, member] of value.entries()) {
    const defect = scalarDefect(member, `${path}[${i}]`);
    if (defect) return defect;
    if (Array.isArray(member)) {
      return fail(
        "wrong-shape",
        `${path}[${i}] arrived as a nested array, expected a scalar`,
      );
    }
  }
  return null;
}

/**
 * Classify the nested-argument probe response: the tool_call must carry named
 * arguments whose `filters` is a genuine array of arrays and whose `fields` is
 * a genuine array of strings — no {"item": …} wrappers, no stringified arrays.
 * @param {any} parsed - the JSON-parsed response body
 * @returns {{ nestedOk: boolean, failure: string|null, detail: string }}
 */
export function classifyNestedToolResponse(parsed) {
  const message = parsed?.choices?.[0]?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length === 0) {
    return fail("no-tool-call", "no structured tool_calls on the nested probe");
  }

  // A call to a tool that was never offered says nothing about nesting. Naming
  // it plainly beats reporting it as mangled arguments — the defect class is
  // the only thing this probe produces, so it must not lie about it.
  const called = toolCalls[0]?.function?.name;
  if (called !== NESTED_TOOL_NAME) {
    return fail(
      "wrong-tool",
      `the model called "${called}" instead of ${NESTED_TOOL_NAME}`,
    );
  }

  const raw = toolCalls[0]?.function?.arguments;
  let args = raw;
  if (typeof raw === "string") {
    try {
      args = JSON.parse(raw);
    } catch {
      return fail(
        "unparseable-arguments",
        `arguments are not valid JSON: ${JSON.stringify(raw.slice(0, 120))}`,
      );
    }
  }

  // Positional arguments: a bare array, or an object keyed "0"/"1"/"2". Pinchy's
  // plugins dispatch on names, so position-only args land in the wrong fields.
  if (Array.isArray(args)) {
    return fail(
      "positional-arguments",
      "arguments arrived as a positional array, not a named object",
    );
  }
  if (!args || typeof args !== "object") {
    return fail(
      "unparseable-arguments",
      `arguments parsed to ${typeof args}, expected an object`,
    );
  }
  const keys = Object.keys(args);
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    return fail(
      "positional-arguments",
      `arguments are keyed positionally (${keys.join(", ")}), not by name`,
    );
  }

  for (const name of NESTED_REQUIRED_ARGS) {
    if (!(name in args)) {
      return fail("wrong-shape", `missing named argument "${name}"`);
    }
  }
  if (typeof args.model !== "string") {
    return fail("wrong-shape", `model arrived as ${typeof args.model}`);
  }

  const filtersDefect = arrayDefect(args.filters, "filters");
  if (filtersDefect) return filtersDefect;

  if (args.filters.length === 0) {
    return fail("wrong-shape", "filters is empty — the domain was dropped");
  }

  for (const [i, triplet] of args.filters.entries()) {
    const defect = arrayDefect(triplet, `filters[${i}]`);
    if (defect) return defect;
    for (const [j, member] of triplet.entries()) {
      const memberDefect = scalarDefect(member, `filters[${i}][${j}]`);
      if (memberDefect) return memberDefect;
    }
  }

  const fieldsDefect = arrayDefect(args.fields, "fields");
  if (fieldsDefect) return fieldsDefect;

  for (const [i, field] of args.fields.entries()) {
    if (looksStringified(field)) {
      return fail(
        "stringified-array",
        `fields[${i}] arrived as a stringified array: ${field}`,
      );
    }
    if (typeof field === "string") continue;
    const wrapper = itemWrapperKey(field);
    if (wrapper) {
      return fail(
        "item-wrapper",
        `fields[${i}] collapsed into a {"${wrapper}": …} wrapper object`,
      );
    }
    return fail(
      "wrong-shape",
      `fields[${i}] arrived as ${Array.isArray(field) ? "an array" : typeof field}, expected a string`,
    );
  }

  return {
    nestedOk: true,
    failure: null,
    detail: `nested arguments intact (${args.filters.length} domain triplet(s), ${args.fields.length} field(s))`,
  };
}

/**
 * Classify a parsed /v1/chat/completions response.
 * @param {any} parsed - the JSON-parsed response body
 * @returns {{ supportsTools: boolean, leakedAsText: boolean, detail: string }}
 */
export function classifyToolResponse(parsed) {
  const message = parsed?.choices?.[0]?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const content = typeof message.content === "string" ? message.content : "";

  const supportsTools = toolCalls.length > 0;
  const leakedAsText =
    !supportsTools && LEAK_PATTERNS.some((re) => re.test(content));

  let detail;
  if (supportsTools) {
    detail = `emitted ${toolCalls.length} structured tool_call(s)`;
  } else if (leakedAsText) {
    detail = "leaked a tool call as plain text (no structured tool_calls)";
  } else {
    detail = "no tool_calls and no leak — model did not call the tool";
  }

  return { supportsTools, leakedAsText, detail };
}
