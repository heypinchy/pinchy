// packages/web/e2e/integration/fake-ollama-server.ts
//
// Minimal Ollama API implementation for integration tests.
// Endpoints used by Pinchy's provider-models.ts:
//   GET  /api/tags   → list models
//   POST /api/show   → model capabilities
// Endpoint used by OpenClaw when routing a chat message:
//   POST /api/chat   → streaming NDJSON response
import * as http from "http";

const MODEL_NAME = "llama3.2";
// This string must appear in the test's expect() assertion
const FAKE_RESPONSE = "Integration test response.";
const DOMAIN_LOCK_TOOL_TRIGGER = "E2E_DOMAIN_LOCK_DOCS_TOOL";
const DOMAIN_LOCK_TOOL_RESPONSE = "Domain lock docs tool call completed.";
const SLOW_STREAM_TRIGGER = "E2E_SLOW_STREAM";
const SLOW_STREAM_RESPONSE = "one two three four five six seven eight nine ten";
const SLOW_STREAM_DELAY_MS = 500;

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
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  // Suppress EPIPE errors when the client disconnects mid-stream.
  res.socket?.on("error", () => {});
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
  return "";
}

function hasToolRole(message: unknown): boolean {
  return (
    !!message && typeof message === "object" && (message as { role?: unknown }).role === "tool"
  );
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
    const isDomainLockToolPrompt =
      messageContent(lastUserMessage).includes(DOMAIN_LOCK_TOOL_TRIGGER);
    const hasToolResult = messages.some(hasToolRole);

    if (isDomainLockToolPrompt && !hasToolResult) {
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
                  name: "docs_list",
                  arguments: {},
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

    const isSlowStreamPrompt = messageContent(lastUserMessage).includes(SLOW_STREAM_TRIGGER);
    if (isSlowStreamPrompt && !hasToolResult) {
      await streamTextResponseSlow(res, SLOW_STREAM_RESPONSE);
      return;
    }

    streamTextResponse(res, isDomainLockToolPrompt ? DOMAIN_LOCK_TOOL_RESPONSE : FAKE_RESPONSE);
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
