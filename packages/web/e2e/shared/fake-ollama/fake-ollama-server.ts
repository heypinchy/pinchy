// packages/web/e2e/shared/fake-ollama/fake-ollama-server.ts
//
// Minimal Ollama API implementation for integration tests.
// Endpoints used by Pinchy's provider-models.ts:
//   GET  /api/tags   → list models
//   POST /api/show   → model capabilities
// Endpoint used by OpenClaw when routing a chat message:
//   POST /api/chat   → streaming NDJSON response
import * as http from "http";
import type { AddressInfo } from "net";

const MODEL_NAME = "llama3.2";
// Default response asserted by the integration test suite. The setup-wizard
// E2E container overrides this via FAKE_OLLAMA_RESPONSE so its spec can
// assert the same canonical "Sure, happy to help..." reply as the other
// provider mocks. Default value is preserved so existing subprocess usage
// (integration tests, telegram tests) is unchanged.
const FAKE_RESPONSE = process.env.FAKE_OLLAMA_RESPONSE ?? "Integration test response.";

// Token-usage emission. Real Ollama/OpenAI providers report a usage block and
// OpenClaw reads it into its per-session cumulative counters — which Pinchy's
// usage poller then turns into usage_records rows. The fake server mirrors
// that so the usage-tracking Tier-2 E2E spec can assert exact token totals.
// Read at request time (not module load) so tests and the integration
// global-setup can tune the numbers via env without a reimport.
const DEFAULT_PROMPT_TOKENS = 42;
const DEFAULT_COMPLETION_TOKENS = 17;

// `userMessageCount` scales BOTH token counts so that successive turns in the
// same session report strictly GROWING cumulative counters. This matters for
// the usage-tracking Tier-2 spec, which asserts against a session that is
// shared across tests (Smithers + the admin user): OpenClaw stores the latest
// call's counters per session and Pinchy's poller records the growth as
// deltas, so a flat count on a non-fresh session could yield a zero delta and
// make the assertion racy. Scaling by the (monotonically increasing) turn
// count guarantees a positive, predictable delta on every turn while keeping
// the declared 42:17 input:output ratio intact — which is the invariant the
// spec checks. (Real output tokens don't grow with history; this is a
// deliberate determinism concession in the fake, not a fidelity claim.)
function getUsageTokens(_userMessageCount = 1): {
  promptTokens: number;
  completionTokens: number;
} {
  // Flat per-turn usage (#483): with lossless per-turn accounting, each turn's
  // trajectory `model.completed` carries that turn's exact tokens and lands as
  // one usage_records row. The fake reports a constant 42:17 per turn (no
  // userMessageCount scaling — that was a gauge-era concession to make a
  // CUMULATIVE counter grow). The E2E asserts EXACT per-turn counts.
  const prompt = Number(process.env.FAKE_OLLAMA_PROMPT_TOKENS);
  const completion = Number(process.env.FAKE_OLLAMA_COMPLETION_TOKENS);
  const basePrompt = Number.isFinite(prompt) && prompt >= 0 ? prompt : DEFAULT_PROMPT_TOKENS;
  const baseCompletion =
    Number.isFinite(completion) && completion >= 0 ? completion : DEFAULT_COMPLETION_TOKENS;
  return { promptTokens: basePrompt, completionTokens: baseCompletion };
}

function countUserMessages(messages: unknown[]): number {
  return messages.filter((m) => (m as { role?: unknown })?.role === "user").length;
}
const DOMAIN_LOCK_TOOL_TRIGGER = "E2E_DOMAIN_LOCK_DOCS_TOOL";
const DOMAIN_LOCK_TOOL_RESPONSE = "Domain lock docs tool call completed.";
const SLOW_STREAM_TRIGGER = "E2E_SLOW_STREAM";
const SLOW_STREAM_RESPONSE = "one two three four five six seven eight nine ten";
const SLOW_STREAM_DELAY_MS = 500;

// ── Chat-liveness triggers ─────────────────────────────────────────────────
// Building blocks for the chat-liveness E2E specs (asserted in a later task).
//
// SLOW: a normal text response that streams genuinely slowly — slow enough for
// a "taking longer than expected" UI state to engage before the stream
// completes. It pauses LIVENESS_SLOW_DELAY_MS before emitting the first token
// (so even a single-word response trips the threshold) and then streams the
// rest word-by-word at SLOW_STREAM_DELAY_MS. The response is multi-word so the
// per-word slow helpers still produce a real incremental stream.
const LIVENESS_SLOW_TRIGGER = "E2E_LIVENESS_SLOW_RESPONSE";
const LIVENESS_SLOW_RESPONSE =
  "Working on it, this is taking a little while to put together for you.";
// Initial stall before the first token. Must sit PAST the client's
// "taking longer than usual" threshold (DELAY_HINT_MS = 15_000 in
// use-ws-runtime.ts) so the banner deterministically engages while the run is
// still in flight — and, because the stall precedes the first token, it engages
// BEFORE any assistant text renders. The run never fails (it completes
// normally afterwards), so this is the regression case proving a slow-but-alive
// run shows the banner and NEVER a failure bubble. 18s gives a ~3s cushion over
// the 15s threshold to stay deterministic on a loaded CI host without making
// the spec needlessly slow.
const LIVENESS_SLOW_DELAY_MS = 18000;

// DYING: simulates a provider/stream failure. On the OpenAI-completions surface
// pi-ai expects a 200 SSE stream, so the most faithful "the provider died
// mid-response" signal is to start the stream, emit a partial token, then tear
// the socket down WITHOUT a finish_reason or [DONE] — an abruptly-ended stream.
// On the Ollama-native surface we do the same: write a partial NDJSON chunk
// (done:false) and destroy the socket. This mirrors a real upstream crash far
// better than a clean error body would, and gives the liveness observer an
// authoritative terminal failure rather than a graceful completion.
const LIVENESS_DYING_TRIGGER = "E2E_LIVENESS_DYING_RESPONSE";
const LIVENESS_DYING_PARTIAL = "Starting to respond";

// ── Transient provider-error triggers (durable agent-error banner) ──────────
// RATE_LIMIT: the provider returns an HTTP 429 with a rate-limit body, the
// canonical "transient, retry later" failure. OpenClaw surfaces it as a chat
// `error` chunk; Pinchy classifies it `transient` (TRANSIENT_PATTERN) and
// persists it to chat_session_errors so the "paused" banner can re-surface it
// after a reload. The body is keyword-dense (rate limit / too many requests /
// overloaded / 429) so that however OpenClaw wraps the provider error into its
// error-chunk text, Pinchy's classifier still reads it as transient.
const RATE_LIMIT_TRIGGER = "E2E_RATE_LIMIT_ERROR";
// TOOL_THEN_RATE_LIMIT: round 1 dispatches a real (read-only) tool, then round 2
// — the follow-up with the tool result — returns the 429. The intervening
// tool_use chunk makes Pinchy record sideEffects=true, so the banner warns that
// a retry may duplicate already-performed actions and gates Retry behind a
// confirmation. pinchy_ls is an always-loaded internal-plugin tool.
const TOOL_THEN_RATE_LIMIT_TRIGGER = "E2E_TOOL_THEN_RATE_LIMIT";
const TOOL_THEN_RATE_LIMIT_TOOL = "pinchy_ls";
const TOOL_THEN_RATE_LIMIT_ARGS = { path: "/data" };

const RATE_LIMIT_ERROR_BODY = {
  error: {
    message:
      "Rate limit reached: too many requests. The model provider is overloaded (HTTP 429). Please try again in a moment.",
    type: "rate_limit_exceeded",
    code: "rate_limit_exceeded",
  },
};

function sendRateLimitError(res: http.ServerResponse) {
  res.writeHead(429, { "Content-Type": "application/json" });
  res.end(JSON.stringify(RATE_LIMIT_ERROR_BODY));
}

// Per-plugin tool triggers — one per plugin, used by behavior tests to assert
// that the plugin loaded and registerTool() worked end-to-end.
const FILES_LS_TRIGGER = "E2E_FILES_LS_TOOL";
const FILES_LS_RESPONSE = "Files listed: coverage probe complete.";
const FILES_READ_DOCX_TRIGGER = "E2E_FILES_READ_DOCX_TOOL";
const FILES_READ_DOCX_RESPONSE = "Docx read: coverage probe complete.";
// Sits inside /data so the default Smithers knowledge-base path matches.
const FILES_READ_DOCX_PATH = "/data/e2e-briefing.docx";
const CONTEXT_SAVE_USER_TRIGGER = "E2E_CONTEXT_SAVE_USER_TOOL";
const CONTEXT_SAVE_USER_RESPONSE = "Context saved: coverage probe complete.";
const ODOO_LIST_MODELS_TRIGGER = "E2E_ODOO_LIST_MODELS_TOOL";
const ODOO_LIST_MODELS_RESPONSE = "Models listed: coverage probe complete.";
const EMAIL_LIST_TRIGGER = "E2E_EMAIL_LIST_TOOL";
const EMAIL_LIST_RESPONSE = "Emails listed: coverage probe complete.";
const EMAIL_SEND_TRIGGER = "E2E_EMAIL_SEND_TOOL";
const EMAIL_SEND_RESPONSE = "Email sent: coverage probe complete.";
const WEB_SEARCH_TRIGGER = "E2E_WEB_SEARCH_TOOL";
const WEB_SEARCH_RESPONSE = "Search complete: coverage probe complete.";
const WORKSPACE_LS_TRIGGER = "E2E_WORKSPACE_LS_TOOL";
const WORKSPACE_LS_RESPONSE = "Workspace listed: coverage probe complete.";
const WORKSPACE_READ_TRIGGER = "E2E_WORKSPACE_READ_TOOL";
const WORKSPACE_READ_RESPONSE = "File read: coverage probe complete.";
const WORKSPACE_WRITE_TRIGGER = "E2E_WORKSPACE_WRITE_TOOL";
const WORKSPACE_WRITE_RESPONSE = "File written: coverage probe complete.";
// An uploaded PDF must be analyzed via pinchy_read (pinchy-files' own PDF
// subsystem), NOT OpenClaw's built-in `pdf` tool — which fails "Unknown model"
// because it resolves only against the per-agent catalog (v0.5.8 finding).
const PDF_ATTACHMENT_READ_TRIGGER = "E2E_PDF_ATTACHMENT_READ_TOOL";
const PDF_ATTACHMENT_READ_RESPONSE = "PDF read: coverage probe complete.";
const IMAGE_CROP_TRIGGER = "E2E_IMAGE_CROP_TOOL";
const IMAGE_CROP_RESPONSE = "Image cropped: coverage probe complete.";

interface TriggerConfig {
  trigger: string;
  response: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

const TOOL_TRIGGERS: TriggerConfig[] = [
  {
    trigger: DOMAIN_LOCK_TOOL_TRIGGER,
    response: DOMAIN_LOCK_TOOL_RESPONSE,
    toolName: "docs_list",
    arguments: {},
  },
  {
    trigger: FILES_LS_TRIGGER,
    response: FILES_LS_RESPONSE,
    toolName: "pinchy_ls",
    arguments: { path: "/data" },
  },
  {
    trigger: FILES_READ_DOCX_TRIGGER,
    response: FILES_READ_DOCX_RESPONSE,
    toolName: "pinchy_read",
    arguments: { path: FILES_READ_DOCX_PATH },
  },
  {
    trigger: CONTEXT_SAVE_USER_TRIGGER,
    response: CONTEXT_SAVE_USER_RESPONSE,
    toolName: "pinchy_save_user_context",
    arguments: { content: "E2E coverage probe" },
  },
  {
    trigger: ODOO_LIST_MODELS_TRIGGER,
    response: ODOO_LIST_MODELS_RESPONSE,
    toolName: "odoo_list_models",
    arguments: {},
  },
  {
    trigger: EMAIL_LIST_TRIGGER,
    response: EMAIL_LIST_RESPONSE,
    toolName: "email_list",
    arguments: {},
  },
  {
    trigger: EMAIL_SEND_TRIGGER,
    response: EMAIL_SEND_RESPONSE,
    toolName: "email_send",
    arguments: {
      to: "probe@example.com",
      subject: "Pinchy E2E probe",
      body: "This is an E2E coverage probe.",
    },
  },
  {
    trigger: WEB_SEARCH_TRIGGER,
    response: WEB_SEARCH_RESPONSE,
    toolName: "pinchy_web_search",
    arguments: { query: "E2E coverage probe" },
  },
  {
    trigger: WORKSPACE_LS_TRIGGER,
    response: WORKSPACE_LS_RESPONSE,
    toolName: "pinchy_ls",
    arguments: { path: "uploads" },
  },
  {
    trigger: WORKSPACE_READ_TRIGGER,
    response: WORKSPACE_READ_RESPONSE,
    toolName: "pinchy_read",
    arguments: { path: "uploads/report.csv" },
  },
  {
    trigger: WORKSPACE_WRITE_TRIGGER,
    response: WORKSPACE_WRITE_RESPONSE,
    toolName: "pinchy_write",
    arguments: { path: "uploads/result.csv", content: "id,value\n1,E2E probe\n" },
  },
  {
    trigger: PDF_ATTACHMENT_READ_TRIGGER,
    response: PDF_ATTACHMENT_READ_RESPONSE,
    toolName: "pinchy_read",
    arguments: { path: "uploads/test.pdf" },
  },
  {
    trigger: IMAGE_CROP_TRIGGER,
    response: IMAGE_CROP_RESPONSE,
    toolName: "image_crop",
    arguments: { source: "receipt.png", x: 0, y: 0, width: 10, height: 10 },
  },
];

function writeNdjson(res: http.ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  for (const chunk of chunks) {
    res.write(JSON.stringify(chunk) + "\n");
  }
  res.end();
}

function streamTextResponse(res: http.ServerResponse, text: string, userMessageCount = 1) {
  const { promptTokens, completionTokens } = getUsageTokens(userMessageCount);
  const chunks = text.split(" ").map((word, i, arr) => ({
    model: MODEL_NAME,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content: i === 0 ? word : " " + word },
    done: i === arr.length - 1,
    ...(i === arr.length - 1 && {
      done_reason: "stop",
      total_duration: 1000000,
      prompt_eval_count: promptTokens,
      eval_count: completionTokens,
    }),
  }));
  writeNdjson(res, chunks);
}

async function streamTextResponseSlow(res: http.ServerResponse, text: string) {
  const { promptTokens, completionTokens } = getUsageTokens();
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Push headers immediately so OpenClaw's streaming reader can attach without
  // waiting for the first data chunk.
  res.flushHeaders();
  // Disable Nagle's algorithm — small NDJSON chunks (~120 bytes each) would
  // otherwise be coalesced at the kernel level, defeating the slow-stream
  // semantics this helper exists for.
  res.socket?.setNoDelay(true);
  // Narrowly suppress EPIPE/ECONNRESET on mid-stream disconnect — those are
  // the expected failure modes when the client tears down. Anything else is
  // a real bug we want to see in the test logs.
  res.socket?.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE" && err.code !== "ECONNRESET") {
      console.error("[fake-ollama] socket error:", err);
    }
  });
  const words = text.split(" ");
  try {
    for (const [index, word] of words.entries()) {
      const isLast = index === words.length - 1;
      const chunk = {
        model: MODEL_NAME,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: index === 0 ? word : " " + word },
        done: isLast,
        ...(isLast && {
          done_reason: "stop",
          total_duration: 1000000,
          prompt_eval_count: promptTokens,
          eval_count: completionTokens,
        }),
      };
      res.write(JSON.stringify(chunk) + "\n");
      if (!isLast) {
        await new Promise((r) => setTimeout(r, SLOW_STREAM_DELAY_MS));
      }
    }
  } catch {
    // Client disconnected mid-stream — normal in mid-stream disconnect tests.
  }
  res.end();
}

// Ollama-native "the provider died mid-response": send headers + one partial
// NDJSON chunk (done:false), then destroy the socket so the client sees a
// truncated, never-completed stream — an authoritative terminal failure.
function streamTextResponseDying(res: http.ServerResponse, partial: string) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  res.socket?.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE" && err.code !== "ECONNRESET") {
      console.error("[fake-ollama] socket error:", err);
    }
  });
  // Flush the partial chunk to the wire BEFORE destroying the socket — the
  // write callback fires once the data has been handed to the kernel, so the
  // client reliably receives the partial token before seeing the reset.
  res.write(
    JSON.stringify({
      model: MODEL_NAME,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: partial },
      done: false,
    }) + "\n",
    () => {
      // Abruptly tear the connection down instead of res.end() — no `done:true`
      // chunk, no done_reason. The client's stream reader sees a premature close.
      setImmediate(() => res.socket?.destroy());
    }
  );
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

function messageContent(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  // OpenAI/pi-ai may emit content as a parts array: [{type:"text", text:"..."}, ...]
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { text?: unknown; content?: unknown };
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

function hasToolRole(message: unknown): boolean {
  return (
    !!message && typeof message === "object" && (message as { role?: unknown }).role === "tool"
  );
}

// Detect whether the LAST exchange in the message history is a tool result —
// i.e. the assistant emitted a tool_call in the previous step and the runtime
// has now sent us back the tool's output to summarise. We split on the most
// recent user message and only look at messages AFTER it. Looking at the whole
// history was wrong: a long-lived chat session that called a tool once would
// then never receive another tool_call response, because `messages.some` saw
// the stale tool message from a previous round.
function lastRoundHasToolResult(messages: unknown[]): boolean {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: unknown })?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) return messages.some(hasToolRole);
  return messages.slice(lastUserIndex + 1).some(hasToolRole);
}

// ── OpenAI-compatible SSE helpers ──────────────────────────────────────────
// Real Ollama exposes both /api/chat (Ollama-native NDJSON) and
// /v1/chat/completions (OpenAI-style SSE). When Pinchy emits OpenClaw's ollama
// provider config it uses `api: "openai-completions"`, which means pi-ai
// inside OC sends requests to /v1/chat/completions. Without these handlers
// every dispatch probe gets a 404 from the fake server and the test times out.

function sseHeaders(res: http.ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
}

function sseWrite(res: http.ServerResponse, chunk: unknown) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function sseDone(res: http.ServerResponse) {
  res.write("data: [DONE]\n\n");
  res.end();
}

function chatCompletionChunk(fields: {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: unknown }>;
  finishReason?: string | null;
}) {
  const delta: Record<string, unknown> = {};
  if (fields.content !== undefined) delta.content = fields.content;
  if (fields.toolCalls) {
    delta.tool_calls = fields.toolCalls.map((tc, index) => ({
      index,
      id: `call_${index}_${Date.now()}`,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_NAME,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: fields.finishReason ?? null,
      },
    ],
  };
}

// Trailing usage-only chunk, mirroring OpenAI's `stream_options.include_usage`
// behaviour: a final chunk with empty `choices` and a `usage` block. OpenClaw's
// pi-ai reads this to populate the session's cumulative token counters.
function usageChunk(userMessageCount = 1) {
  const { promptTokens, completionTokens } = getUsageTokens(userMessageCount);
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_NAME,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function streamOpenAiText(res: http.ServerResponse, text: string, userMessageCount = 1) {
  sseHeaders(res);
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    const piece = i === 0 ? words[i] : " " + words[i];
    sseWrite(res, chatCompletionChunk({ content: piece }));
  }
  sseWrite(res, chatCompletionChunk({ finishReason: "stop" }));
  sseWrite(res, usageChunk(userMessageCount));
  sseDone(res);
}

/**
 * OpenAI-compatible slow stream: emits words one-by-one via SSE with
 * SLOW_STREAM_DELAY_MS between tokens. Mirrors streamTextResponseSlow() but
 * uses the SSE format expected by OC's openai-completions provider (which
 * Pinchy emits for ollama providers via `api: "openai-completions"`).
 *
 * Required because pi-ai in OC uses /v1/chat/completions (not /api/chat), so
 * the Ollama-native slow-stream path at POST /api/chat is never reached. The
 * stream-persistence and in-app-navigation integration tests rely on seeing
 * the first word of the response before the full response arrives, so they
 * need a genuinely slow per-word stream — not just a fast bulk response.
 */
async function streamOpenAiTextSlow(res: http.ServerResponse, text: string) {
  sseHeaders(res);
  // Disable Nagle's algorithm so each small SSE chunk is sent immediately
  // rather than being coalesced at the kernel level. Mirrors the same
  // setNoDelay call in streamTextResponseSlow.
  res.socket?.setNoDelay(true);
  res.socket?.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE" && err.code !== "ECONNRESET") {
      console.error("[fake-ollama] socket error:", err);
    }
  });
  const words = text.split(" ");
  try {
    for (let i = 0; i < words.length; i++) {
      const piece = i === 0 ? words[i] : " " + words[i];
      sseWrite(res, chatCompletionChunk({ content: piece }));
      if (i < words.length - 1) {
        await new Promise((r) => setTimeout(r, SLOW_STREAM_DELAY_MS));
      }
    }
    sseWrite(res, chatCompletionChunk({ finishReason: "stop" }));
    // Usage on the slow path too — same no-usage flake class as tool calls.
    sseWrite(res, usageChunk());
    sseDone(res);
  } catch {
    // Client disconnected mid-stream — normal in mid-stream disconnect tests.
  }
}

/**
 * OpenAI-compatible "taking longer than expected" stream: stalls for
 * `initialDelayMs` BEFORE the first token, then streams word-by-word at
 * SLOW_STREAM_DELAY_MS and completes normally. The leading stall is what lets a
 * single liveness threshold engage regardless of response length — mirrors a
 * real provider that's slow to start generating.
 */
async function streamOpenAiTextSlowStart(
  res: http.ServerResponse,
  text: string,
  initialDelayMs: number
) {
  sseHeaders(res);
  res.socket?.setNoDelay(true);
  res.socket?.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE" && err.code !== "ECONNRESET") {
      console.error("[fake-ollama] socket error:", err);
    }
  });
  const words = text.split(" ");
  try {
    await new Promise((r) => setTimeout(r, initialDelayMs));
    for (let i = 0; i < words.length; i++) {
      const piece = i === 0 ? words[i] : " " + words[i];
      sseWrite(res, chatCompletionChunk({ content: piece }));
      if (i < words.length - 1) {
        await new Promise((r) => setTimeout(r, SLOW_STREAM_DELAY_MS));
      }
    }
    sseWrite(res, chatCompletionChunk({ finishReason: "stop" }));
    sseDone(res);
  } catch {
    // Client disconnected mid-stream — normal in mid-stream disconnect tests.
  }
}

// Ollama-native "taking longer than expected": same leading-stall semantics as
// streamOpenAiTextSlowStart but in NDJSON, for the /api/chat surface.
async function streamTextResponseSlowStart(
  res: http.ServerResponse,
  text: string,
  initialDelayMs: number
) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  res.socket?.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE" && err.code !== "ECONNRESET") {
      console.error("[fake-ollama] socket error:", err);
    }
  });
  const words = text.split(" ");
  try {
    await new Promise((r) => setTimeout(r, initialDelayMs));
    for (const [index, word] of words.entries()) {
      const isLast = index === words.length - 1;
      const chunk = {
        model: MODEL_NAME,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: index === 0 ? word : " " + word },
        done: isLast,
        ...(isLast && { done_reason: "stop", total_duration: 1000000 }),
      };
      res.write(JSON.stringify(chunk) + "\n");
      if (!isLast) {
        await new Promise((r) => setTimeout(r, SLOW_STREAM_DELAY_MS));
      }
    }
  } catch {
    // Client disconnected mid-stream — normal in mid-stream disconnect tests.
  }
  res.end();
}

// OpenAI-compatible "the provider died mid-response": open the SSE stream, emit
// one partial token, then destroy the socket — no finish_reason, no [DONE].
// pi-ai's stream reader sees a premature close, the authoritative terminal
// failure the liveness observer must surface.
function streamOpenAiTextDying(res: http.ServerResponse, partial: string) {
  sseHeaders(res);
  res.socket?.setNoDelay(true);
  res.socket?.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE" && err.code !== "ECONNRESET") {
      console.error("[fake-ollama] socket error:", err);
    }
  });
  // Flush the partial SSE chunk before destroying the socket so the client
  // reliably receives the partial token ahead of the connection reset.
  res.write(`data: ${JSON.stringify(chatCompletionChunk({ content: partial }))}\n\n`, () => {
    // Abruptly tear the connection down — no finish_reason:stop, no usage,
    // no [DONE]. The client's stream reader sees a premature close.
    setImmediate(() => res.socket?.destroy());
  });
}

function streamOpenAiToolCalls(
  res: http.ServerResponse,
  toolName: string,
  args: Record<string, unknown>
) {
  sseHeaders(res);
  sseWrite(res, chatCompletionChunk({ toolCalls: [{ name: toolName, arguments: args }] }));
  sseWrite(res, chatCompletionChunk({ finishReason: "tool_calls" }));
  // Emit usage even on tool-call turns. Without it OpenClaw self-estimates the
  // real prompt size (~18k) and writes that into the trajectory, contaminating
  // the per-turn usage_records rows and flaking usage-tracking.spec.ts.
  sseWrite(res, usageChunk());
  sseDone(res);
}

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "";
  const method = req.method ?? "";

  if (method === "GET" && url === "/__pinchy_fake_ollama") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: MODEL_NAME }));
    return;
  }

  if (method === "GET" && url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        models: [
          {
            name: MODEL_NAME,
            details: { parameter_size: "1B" },
          },
        ],
      })
    );
    return;
  }

  if (method === "POST" && url === "/api/show") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        capabilities: ["completion", "tools"], // "tools" = compatible with agent tool-use
        details: { parameter_size: "1B" },
        // Advertise llama3.2's real context window. Pinchy reads this via
        // provider-models.ts extractOllamaContextLength and emits it as the
        // model's `contextWindow` into openclaw.json. Without it, build.ts
        // falls back to OLLAMA_LOCAL_DEFAULT_CONTEXT_WINDOW (32_768); the
        // Smithers integration session accumulates ~32k tokens across the
        // dispatch-probe suite, and once it crosses a 32k window OpenClaw
        // 2026.5.28's cli_budget / overflow compaction fires — which the fake
        // LLM cannot satisfy (it can't summarize), so the agent run fails with
        // UNAVAILABLE and the tool never dispatches. Real llama3.2 is 131072,
        // so advertising it keeps the context window from being the bottleneck.
        model_info: { "llama.context_length": 131072 },
      })
    );
    return;
  }

  if (method === "POST" && url === "/api/chat") {
    const payload = await readJsonBody(req);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => (message as { role?: unknown })?.role === "user");
    const hasToolResult = lastRoundHasToolResult(messages);

    const lastContent = messageContent(lastUserMessage);
    const activeTrigger = TOOL_TRIGGERS.find(({ trigger }) => lastContent.includes(trigger));

    if (activeTrigger && !hasToolResult) {
      const { promptTokens, completionTokens } = getUsageTokens(countUserMessages(messages));
      writeNdjson(res, [
        {
          model: MODEL_NAME,
          created_at: new Date().toISOString(),
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: activeTrigger.toolName,
                  arguments: activeTrigger.arguments,
                },
              },
            ],
          },
          done: true,
          done_reason: "stop",
          total_duration: 1000000,
          // Usage even on tool-call turns — see streamOpenAiToolCalls for why.
          prompt_eval_count: promptTokens,
          eval_count: completionTokens,
        },
      ]);
      return;
    }

    const isSlowStreamPrompt = lastContent.includes(SLOW_STREAM_TRIGGER);
    if (isSlowStreamPrompt && !hasToolResult) {
      await streamTextResponseSlow(res, SLOW_STREAM_RESPONSE);
      return;
    }

    if (lastContent.includes(LIVENESS_DYING_TRIGGER) && !hasToolResult) {
      streamTextResponseDying(res, LIVENESS_DYING_PARTIAL);
      return;
    }

    if (lastContent.includes(LIVENESS_SLOW_TRIGGER) && !hasToolResult) {
      await streamTextResponseSlowStart(res, LIVENESS_SLOW_RESPONSE, LIVENESS_SLOW_DELAY_MS);
      return;
    }

    if (lastContent.includes(RATE_LIMIT_TRIGGER) && !hasToolResult) {
      sendRateLimitError(res);
      return;
    }

    if (lastContent.includes(TOOL_THEN_RATE_LIMIT_TRIGGER)) {
      if (hasToolResult) {
        sendRateLimitError(res);
      } else {
        const { promptTokens, completionTokens } = getUsageTokens(countUserMessages(messages));
        writeNdjson(res, [
          {
            model: MODEL_NAME,
            created_at: new Date().toISOString(),
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  function: {
                    name: TOOL_THEN_RATE_LIMIT_TOOL,
                    arguments: TOOL_THEN_RATE_LIMIT_ARGS,
                  },
                },
              ],
            },
            done: true,
            done_reason: "stop",
            total_duration: 1000000,
            prompt_eval_count: promptTokens,
            eval_count: completionTokens,
          },
        ]);
      }
      return;
    }

    streamTextResponse(
      res,
      activeTrigger ? activeTrigger.response : FAKE_RESPONSE,
      countUserMessages(messages)
    );
    return;
  }

  // ── OpenAI-compatible API surface (Pinchy emits ollama as api:
  // "openai-completions" so pi-ai inside OpenClaw uses /v1/chat/completions
  // + /v1/models, not the Ollama-native /api/* surface).
  if (method === "GET" && url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: MODEL_NAME,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "ollama",
          },
        ],
      })
    );
    return;
  }

  if (method === "POST" && url === "/v1/chat/completions") {
    const payload = await readJsonBody(req);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => (message as { role?: unknown })?.role === "user");
    const hasToolResult = lastRoundHasToolResult(messages);
    const lastContent = messageContent(lastUserMessage);
    const activeTrigger = TOOL_TRIGGERS.find(({ trigger }) => lastContent.includes(trigger));

    if (activeTrigger && !hasToolResult) {
      streamOpenAiToolCalls(res, activeTrigger.toolName, activeTrigger.arguments);
      return;
    }

    // Slow-stream trigger: Pinchy emits ollama as api: "openai-completions" so
    // OC's pi-ai uses /v1/chat/completions, not /api/chat. The slow-stream
    // handler must live on this path too or stream-persistence tests never
    // see the first token within their 30 s window.
    const isSlowStreamPrompt = lastContent.includes(SLOW_STREAM_TRIGGER);
    if (isSlowStreamPrompt && !hasToolResult) {
      await streamOpenAiTextSlow(res, SLOW_STREAM_RESPONSE);
      return;
    }

    // Liveness DYING: abruptly-ended stream (provider death). Checked before the
    // slow trigger because both are independent prompts; order is for clarity.
    if (lastContent.includes(LIVENESS_DYING_TRIGGER) && !hasToolResult) {
      streamOpenAiTextDying(res, LIVENESS_DYING_PARTIAL);
      return;
    }

    // Liveness SLOW: stalls before the first token so a "taking longer" UI state
    // engages, then completes normally.
    if (lastContent.includes(LIVENESS_SLOW_TRIGGER) && !hasToolResult) {
      await streamOpenAiTextSlowStart(res, LIVENESS_SLOW_RESPONSE, LIVENESS_SLOW_DELAY_MS);
      return;
    }

    // Transient rate-limit error (durable banner). A bare 429 surfaces as a
    // transient chat error chunk.
    if (lastContent.includes(RATE_LIMIT_TRIGGER) && !hasToolResult) {
      sendRateLimitError(res);
      return;
    }

    // Tool-then-rate-limit: round 1 dispatches a tool, round 2 (with the tool
    // result) returns the 429 — a failure AFTER a side effect.
    if (lastContent.includes(TOOL_THEN_RATE_LIMIT_TRIGGER)) {
      if (hasToolResult) {
        sendRateLimitError(res);
      } else {
        streamOpenAiToolCalls(res, TOOL_THEN_RATE_LIMIT_TOOL, TOOL_THEN_RATE_LIMIT_ARGS);
      }
      return;
    }

    streamOpenAiText(
      res,
      activeTrigger ? activeTrigger.response : FAKE_RESPONSE,
      countUserMessages(messages)
    );
    return;
  }

  // 404 for anything else
  res.writeHead(404);
  res.end();
}

export const FAKE_OLLAMA_PORT = 11435;
export const FAKE_OLLAMA_MODEL = `ollama/${MODEL_NAME}`;
// Token counts emitted on every completion when FAKE_OLLAMA_PROMPT_TOKENS /
// FAKE_OLLAMA_COMPLETION_TOKENS are unset (the integration default). The
// usage-tracking Tier-2 spec asserts against these exact numbers.
export const FAKE_OLLAMA_DEFAULT_PROMPT_TOKENS = DEFAULT_PROMPT_TOKENS;
export const FAKE_OLLAMA_DEFAULT_COMPLETION_TOKENS = DEFAULT_COMPLETION_TOKENS;
export const FAKE_OLLAMA_RESPONSE = FAKE_RESPONSE;
export const FAKE_OLLAMA_DOMAIN_LOCK_TOOL_TRIGGER = DOMAIN_LOCK_TOOL_TRIGGER;
export const FAKE_OLLAMA_DOMAIN_LOCK_TOOL_RESPONSE = DOMAIN_LOCK_TOOL_RESPONSE;
export const FAKE_OLLAMA_SLOW_STREAM_TRIGGER = SLOW_STREAM_TRIGGER;
export const FAKE_OLLAMA_SLOW_STREAM_RESPONSE = SLOW_STREAM_RESPONSE;
export const FAKE_OLLAMA_SLOW_STREAM_DELAY_MS = SLOW_STREAM_DELAY_MS;
// Chat-liveness triggers (slow "taking longer" + dying provider failure).
export const FAKE_OLLAMA_LIVENESS_SLOW_TRIGGER = LIVENESS_SLOW_TRIGGER;
export const FAKE_OLLAMA_LIVENESS_SLOW_RESPONSE = LIVENESS_SLOW_RESPONSE;
export const FAKE_OLLAMA_LIVENESS_SLOW_DELAY_MS = LIVENESS_SLOW_DELAY_MS;
export const FAKE_OLLAMA_LIVENESS_DYING_TRIGGER = LIVENESS_DYING_TRIGGER;
export const FAKE_OLLAMA_LIVENESS_DYING_PARTIAL = LIVENESS_DYING_PARTIAL;
// Transient provider-error triggers (durable agent-error banner).
export const FAKE_OLLAMA_RATE_LIMIT_TRIGGER = RATE_LIMIT_TRIGGER;
export const FAKE_OLLAMA_TOOL_THEN_RATE_LIMIT_TRIGGER = TOOL_THEN_RATE_LIMIT_TRIGGER;
export const FAKE_OLLAMA_TOOL_THEN_RATE_LIMIT_TOOL = TOOL_THEN_RATE_LIMIT_TOOL;
export const FAKE_OLLAMA_FILES_LS_TOOL_TRIGGER = FILES_LS_TRIGGER;
export const FAKE_OLLAMA_FILES_LS_TOOL_RESPONSE = FILES_LS_RESPONSE;
export const FAKE_OLLAMA_FILES_READ_DOCX_TOOL_TRIGGER = FILES_READ_DOCX_TRIGGER;
export const FAKE_OLLAMA_FILES_READ_DOCX_TOOL_RESPONSE = FILES_READ_DOCX_RESPONSE;
export const FAKE_OLLAMA_FILES_READ_DOCX_PATH = FILES_READ_DOCX_PATH;
export const FAKE_OLLAMA_CONTEXT_SAVE_USER_TOOL_TRIGGER = CONTEXT_SAVE_USER_TRIGGER;
export const FAKE_OLLAMA_CONTEXT_SAVE_USER_TOOL_RESPONSE = CONTEXT_SAVE_USER_RESPONSE;
export const FAKE_OLLAMA_ODOO_LIST_MODELS_TOOL_TRIGGER = ODOO_LIST_MODELS_TRIGGER;
export const FAKE_OLLAMA_ODOO_LIST_MODELS_TOOL_RESPONSE = ODOO_LIST_MODELS_RESPONSE;
export const FAKE_OLLAMA_EMAIL_LIST_TOOL_TRIGGER = EMAIL_LIST_TRIGGER;
export const FAKE_OLLAMA_EMAIL_LIST_TOOL_RESPONSE = EMAIL_LIST_RESPONSE;
export const FAKE_OLLAMA_EMAIL_SEND_TOOL_TRIGGER = EMAIL_SEND_TRIGGER;
export const FAKE_OLLAMA_EMAIL_SEND_TOOL_RESPONSE = EMAIL_SEND_RESPONSE;
export const FAKE_OLLAMA_WEB_SEARCH_TOOL_TRIGGER = WEB_SEARCH_TRIGGER;
export const FAKE_OLLAMA_WEB_SEARCH_TOOL_RESPONSE = WEB_SEARCH_RESPONSE;
export const FAKE_OLLAMA_WORKSPACE_LS_TOOL_TRIGGER = WORKSPACE_LS_TRIGGER;
export const FAKE_OLLAMA_WORKSPACE_LS_TOOL_RESPONSE = WORKSPACE_LS_RESPONSE;
export const FAKE_OLLAMA_WORKSPACE_READ_TOOL_TRIGGER = WORKSPACE_READ_TRIGGER;
export const FAKE_OLLAMA_WORKSPACE_READ_TOOL_RESPONSE = WORKSPACE_READ_RESPONSE;
export const FAKE_OLLAMA_WORKSPACE_WRITE_TOOL_TRIGGER = WORKSPACE_WRITE_TRIGGER;
export const FAKE_OLLAMA_WORKSPACE_WRITE_TOOL_RESPONSE = WORKSPACE_WRITE_RESPONSE;
export const FAKE_OLLAMA_PDF_ATTACHMENT_READ_TOOL_TRIGGER = PDF_ATTACHMENT_READ_TRIGGER;
export const FAKE_OLLAMA_PDF_ATTACHMENT_READ_TOOL_RESPONSE = PDF_ATTACHMENT_READ_RESPONSE;
export const FAKE_OLLAMA_IMAGE_CROP_TOOL_TRIGGER = IMAGE_CROP_TRIGGER;
export const FAKE_OLLAMA_IMAGE_CROP_TOOL_RESPONSE = IMAGE_CROP_RESPONSE;

let server: http.Server | null = null;

/**
 * Start the fake-ollama HTTP server and resolve with the actual bound port.
 *
 * @param port  Port to bind. Defaults to the well-known FAKE_OLLAMA_PORT (11435)
 *   that the Dockerized E2E stack / OpenClaw connect to. Pass 0 for an
 *   OS-assigned ephemeral port (used by in-process tests so they never collide
 *   with a concurrent holder of 11435).
 *
 * Rejects — rather than hanging on a listen callback that never fires while the
 * unhandled 'error' event crashes the process — if the port is already in use
 * (EADDRINUSE) or listen otherwise fails, or if a server is already running.
 */
export function startFakeOllama(port: number = FAKE_OLLAMA_PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server) {
      reject(new Error("[fake-ollama] already started; call stopFakeOllama() first"));
      return;
    }
    const s = http.createServer(handleRequest);
    const onStartupError = (err: Error) => {
      // listen() failed (e.g. EADDRINUSE) — surface it as a rejection and leave
      // no half-constructed, never-listening server behind (which would make a
      // later stopFakeOllama() reject with ERR_SERVER_NOT_RUNNING).
      server = null;
      reject(err);
    };
    s.once("error", onStartupError);
    s.listen(port, "0.0.0.0", () => {
      server = s;
      s.removeListener("error", onStartupError);
      // Surface, rather than crash on, any later server-level socket error.
      s.on("error", (err) => console.error("[fake-ollama] server error:", err));
      const boundPort = (s.address() as AddressInfo).port;
      console.log(`[fake-ollama] listening on port ${boundPort}`);
      resolve(boundPort);
    });
  });
}

export function stopFakeOllama(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((err) => (err ? reject(err) : resolve()));
    server = null;
  });
}
