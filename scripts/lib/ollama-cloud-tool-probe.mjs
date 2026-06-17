// Pure helpers for the Ollama Cloud tool-calling probe.
//
// `verify-ollama-cloud-tools.mjs` POSTs a small function-tool request to
// https://ollama.com/v1/chat/completions for each curated model and checks the
// reply. Every model in TOOL_CAPABLE_OLLAMA_CLOUD_MODELS is, by definition,
// expected to emit a *structured* tool_call — a model that silently skips the
// call (qwen3-next's empty-content failure) or leaks the call as plain text
// (gemini-3-flash-preview's `default_api` signature) must not be surfaced as
// tool-capable, because every Pinchy agent relies on tools (files/context/docs).
//
// These two functions are the request shape and the response classifier, kept
// pure so the network wrapper stays thin and this logic is unit-tested.

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
