// packages/web/e2e/shared/fake-ollama/fake-ollama-server.ts
//
// Minimal Ollama API implementation for integration tests.
// Endpoints used by Pinchy's provider-models.ts:
//   GET  /api/tags   → list models
//   POST /api/show   → model capabilities
// Endpoint used by OpenClaw when routing a chat message:
//   POST /api/chat   → streaming NDJSON response
import * as http from "http";

const MODEL_NAME = "llama3.2";
// Default response asserted by the integration test suite. The setup-wizard
// E2E container overrides this via FAKE_OLLAMA_RESPONSE so its spec can
// assert the same canonical "Sure, happy to help..." reply as the other
// provider mocks. Default value is preserved so existing subprocess usage
// (integration tests, telegram tests) is unchanged.
const FAKE_RESPONSE = process.env.FAKE_OLLAMA_RESPONSE ?? "Integration test response.";
const DOMAIN_LOCK_TOOL_TRIGGER = "E2E_DOMAIN_LOCK_DOCS_TOOL";
const DOMAIN_LOCK_TOOL_RESPONSE = "Domain lock docs tool call completed.";
const SLOW_STREAM_TRIGGER = "E2E_SLOW_STREAM";
const SLOW_STREAM_RESPONSE = "one two three four five six seven eight nine ten";
const SLOW_STREAM_DELAY_MS = 500;

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
];

function writeNdjson(res: http.ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  for (const chunk of chunks) {
    res.write(JSON.stringify(chunk) + "\n");
  }
  res.end();
}

function streamTextResponse(res: http.ServerResponse, text: string) {
  const chunks = text.split(" ").map((word, i, arr) => ({
    model: MODEL_NAME,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content: i === 0 ? word : " " + word },
    done: i === arr.length - 1,
    ...(i === arr.length - 1 && { done_reason: "stop", total_duration: 1000000 }),
  }));
  writeNdjson(res, chunks);
}

async function streamTextResponseSlow(res: http.ServerResponse, text: string) {
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

function streamOpenAiText(res: http.ServerResponse, text: string) {
  sseHeaders(res);
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    const piece = i === 0 ? words[i] : " " + words[i];
    sseWrite(res, chatCompletionChunk({ content: piece }));
  }
  sseWrite(res, chatCompletionChunk({ finishReason: "stop" }));
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
    sseDone(res);
  } catch {
    // Client disconnected mid-stream — normal in mid-stream disconnect tests.
  }
}

function streamOpenAiToolCalls(
  res: http.ServerResponse,
  toolName: string,
  args: Record<string, unknown>
) {
  sseHeaders(res);
  sseWrite(res, chatCompletionChunk({ toolCalls: [{ name: toolName, arguments: args }] }));
  sseWrite(res, chatCompletionChunk({ finishReason: "tool_calls" }));
  sseDone(res);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
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
        },
      ]);
      return;
    }

    const isSlowStreamPrompt = lastContent.includes(SLOW_STREAM_TRIGGER);
    if (isSlowStreamPrompt && !hasToolResult) {
      await streamTextResponseSlow(res, SLOW_STREAM_RESPONSE);
      return;
    }

    streamTextResponse(res, activeTrigger ? activeTrigger.response : FAKE_RESPONSE);
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

    streamOpenAiText(res, activeTrigger ? activeTrigger.response : FAKE_RESPONSE);
    return;
  }

  // 404 for anything else
  res.writeHead(404);
  res.end();
}

export const FAKE_OLLAMA_PORT = 11435;
export const FAKE_OLLAMA_MODEL = `ollama/${MODEL_NAME}`;
export const FAKE_OLLAMA_RESPONSE = FAKE_RESPONSE;
export const FAKE_OLLAMA_DOMAIN_LOCK_TOOL_TRIGGER = DOMAIN_LOCK_TOOL_TRIGGER;
export const FAKE_OLLAMA_DOMAIN_LOCK_TOOL_RESPONSE = DOMAIN_LOCK_TOOL_RESPONSE;
export const FAKE_OLLAMA_SLOW_STREAM_TRIGGER = SLOW_STREAM_TRIGGER;
export const FAKE_OLLAMA_SLOW_STREAM_RESPONSE = SLOW_STREAM_RESPONSE;
export const FAKE_OLLAMA_SLOW_STREAM_DELAY_MS = SLOW_STREAM_DELAY_MS;
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

let server: http.Server | null = null;

export function startFakeOllama(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer(handleRequest);
    server.listen(FAKE_OLLAMA_PORT, "0.0.0.0", () => {
      console.log(`[fake-ollama] listening on port ${FAKE_OLLAMA_PORT}`);
      resolve();
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
