import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

// One-line request log so E2E CI failures show whether OpenClaw / Pinchy
// reached the mock at all. The setup-wizard-e2e job tails this container's
// logs on failure (see .github/workflows/ci.yml setup-wizard-e2e job).
// /control/health is excluded because Docker's healthcheck polls it every
// 5s — without this filter the meaningful requests get pushed out of the
// log tail window. JSON.stringify escapes \r/\n/control chars and quotes
// so a crafted request can't forge fake log entries (CodeQL js/log-injection).
app.use((req, _res, next) => {
  if (req.url !== "/control/health") {
    console.log(`[mock] ${JSON.stringify(req.method)} ${JSON.stringify(req.url)}`);
  }
  next();
});

// Tiny auth helpers. Each provider has a different scheme — keep these
// as one-liners and add new ones as new providers are added (Anthropic
// uses x-api-key, Google uses ?key=, etc).
function requireBearer(req, res) {
  if (req.headers.authorization?.startsWith("Bearer ")) return true;
  res.status(401).json({ error: { message: "Missing API key" } });
  return false;
}

function requireXApiKey(req, res) {
  if (req.headers["x-api-key"]) return true;
  res.status(401).json({ type: "error", error: { type: "authentication_error", message: "missing api key" } });
  return false;
}

function requireQueryKey(req, res) {
  if (req.query.key) return true;
  res.status(403).json({ error: { code: 403, message: "missing key" } });
  return false;
}

// Frozen "created" timestamp for response determinism. Mock servers
// asserting on full response shapes (E2E snapshots, audit-log fixtures)
// rely on this — never replace with Date.now().
const MOCK_CREATED_AT = 1700000000;

// Frozen assistant reply for response determinism. Shared across all
// provider handlers so E2E specs can assert one canonical message in
// Pinchy's chat surface. Never replace with a dynamic string.
const MOCK_ASSISTANT_REPLY = "Sure, happy to help! What would you like to work on?";

const PORT = process.env.PORT || 9100;

// ---- Control ----
app.get("/control/health", (_req, res) => res.json({ ok: true }));

// ---- OpenAI ----
app.get("/openai/v1/models", (req, res) => {
  if (!requireBearer(req, res)) return;
  res.json({
    object: "list",
    data: [
      { id: "gpt-5.5-2026-04-23", object: "model", created: MOCK_CREATED_AT, owned_by: "openai" },
      { id: "gpt-5.5", object: "model", created: MOCK_CREATED_AT, owned_by: "openai" },
      { id: "gpt-5.4", object: "model", created: MOCK_CREATED_AT, owned_by: "openai" },
      { id: "gpt-5.4-mini", object: "model", created: MOCK_CREATED_AT, owned_by: "openai" },
    ],
  });
});

// OpenAI's new Responses API (replaces /chat/completions for newer models).
// pi-ai's openai-responses provider parses SSE events with type prefix
// `response.*`. Minimum required: response.created → response.output_text.delta
// (carries the text) → response.completed (signals end of stream).
app.post("/openai/v1/responses", (req, res) => {
  if (!requireBearer(req, res)) return;
  const model = req.body?.model ?? "gpt-5.5";
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const responseId = "resp_mock_1";
  const baseResponse = {
    id: responseId,
    object: "response",
    created_at: MOCK_CREATED_AT,
    model,
    status: "in_progress",
    output: [],
    usage: null,
  };
  res.write(sse("response.created", { type: "response.created", response: baseResponse }));
  res.write(
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: "item_mock_1",
      output_index: 0,
      content_index: 0,
      delta: MOCK_ASSISTANT_REPLY,
    })
  );
  res.write(
    sse("response.completed", {
      type: "response.completed",
      response: {
        ...baseResponse,
        status: "completed",
        output: [
          {
            id: "item_mock_1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: MOCK_ASSISTANT_REPLY }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 },
      },
    })
  );
  res.end();
});

app.post("/openai/v1/chat/completions", (req, res) => {
  if (!requireBearer(req, res)) return;
  res.json({
    id: "chatcmpl-mock-1",
    object: "chat.completion",
    created: MOCK_CREATED_AT,
    model: req.body?.model ?? "gpt-5.5",
    choices: [
      { index: 0, message: { role: "assistant", content: MOCK_ASSISTANT_REPLY }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
  });
});

// ---- Anthropic ----
app.get("/anthropic/v1/models", (req, res) => {
  if (!requireXApiKey(req, res)) return;
  res.json({
    data: [
      { id: "claude-sonnet-4-6", type: "model", display_name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", type: "model", display_name: "Claude Haiku 4.5" },
    ],
  });
});

app.post("/anthropic/v1/messages", (req, res) => {
  if (!requireXApiKey(req, res)) return;
  const model = req.body?.model ?? "claude-sonnet-4-6";

  // pi-ai (used by OpenClaw) always sends `stream: true` on this endpoint.
  // Return SSE with the event sequence iterateAnthropicEvents expects in
  // node_modules/.../@earendil-works/pi-ai/dist/providers/anthropic.js —
  // message_start, content_block_start/delta/stop, message_delta,
  // message_stop. Missing message_stop throws "Anthropic stream ended
  // before message_stop".
  if (req.body?.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(
      sse("message_start", {
        type: "message_start",
        message: {
          id: "msg_mock_1",
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })
    );
    res.write(
      sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })
    );
    res.write(
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: MOCK_ASSISTANT_REPLY },
      })
    );
    res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
    res.write(
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 12 },
      })
    );
    res.write(sse("message_stop", { type: "message_stop" }));
    res.end();
    return;
  }

  // Non-streaming fallback — kept for the validateProviderKey probe path
  // (which sends body: "{}" and only cares about the HTTP status).
  res.json({
    id: "msg_mock_1",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: MOCK_ASSISTANT_REPLY }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 12 },
  });
});

// ---- Google ----
app.get("/google/v1beta/models", (req, res) => {
  if (!requireQueryKey(req, res)) return;
  res.json({
    models: [
      { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
    ],
  });
});

app.post("/google/v1beta/models/:model\\:generateContent", (req, res) => {
  if (!requireQueryKey(req, res)) return;
  res.json({
    candidates: [
      { content: { role: "model", parts: [{ text: MOCK_ASSISTANT_REPLY }] }, finishReason: "STOP" },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 8, totalTokenCount: 13 },
  });
});

// pi-ai's @google/genai SDK uses :streamGenerateContent for chat (not the
// non-streaming :generateContent). Response is SSE: `data: <JSON>\n\n` chunks
// with candidates[].content.parts[].text deltas. Single-chunk emission with
// finishReason on it is the simplest valid stream the parser accepts.
app.post("/google/v1beta/models/:model\\:streamGenerateContent", (req, res) => {
  if (!requireQueryKey(req, res)) return;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(
    `data: ${JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: MOCK_ASSISTANT_REPLY }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 8, totalTokenCount: 13 },
    })}\n\n`
  );
  res.end();
});

// ---- Ollama Cloud ----
// Ollama Cloud is OpenAI-compatible. We mount its routes under
// /ollama-cloud/v1/* and reuse the OpenAI response shape.
app.get("/ollama-cloud/v1/models", (req, res) => {
  if (!requireBearer(req, res)) return;
  res.json({
    object: "list",
    data: [
      { id: "qwen3-next:80b", object: "model", created: MOCK_CREATED_AT, owned_by: "ollama" },
      { id: "qwen3-coder:480b", object: "model", created: MOCK_CREATED_AT, owned_by: "ollama" },
    ],
  });
});

app.post("/ollama-cloud/v1/chat/completions", (req, res) => {
  if (!requireBearer(req, res)) return;
  // Validation-probe contract: Pinchy's wizard sends body: "{}" to check
  // whether the Bearer is valid. The real ollama.com returns 400 in that
  // case (auth passed, body rejected) and providers.ts:141 treats 400 as
  // "key is valid". We replicate that: missing `messages` → 400.
  if (!Array.isArray(req.body?.messages) || req.body.messages.length === 0) {
    return res.status(400).json({ error: { message: "messages: array required" } });
  }
  res.json({
    id: "chatcmpl-mock-ollama-1",
    object: "chat.completion",
    created: MOCK_CREATED_AT,
    model: req.body?.model ?? "qwen3-next:80b",
    choices: [
      { index: 0, message: { role: "assistant", content: MOCK_ASSISTANT_REPLY }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
  });
});

app.listen(PORT, () => console.log(`llm-providers-mock listening on ${PORT}`));
