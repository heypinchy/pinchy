import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

// One-line request log so E2E CI failures show whether OpenClaw / Pinchy
// reached the mock at all. The setup-wizard-e2e job tails this container's
// logs on failure (see .github/workflows/ci.yml setup-wizard-e2e job).
// JSON.stringify escapes \r/\n/control chars and quotes so a crafted
// request can't forge fake log entries — recognized by CodeQL as a
// sanitizer for js/log-injection.
app.use((req, _res, next) => {
  console.log(`[mock] ${JSON.stringify(req.method)} ${JSON.stringify(req.url)}`);
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
  res.json({
    id: "msg_mock_1",
    type: "message",
    role: "assistant",
    model: req.body?.model ?? "claude-sonnet-4-6",
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
