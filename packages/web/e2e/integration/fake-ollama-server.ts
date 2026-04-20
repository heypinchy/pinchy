// packages/web/e2e/integration/fake-ollama-server.ts
//
// Minimal Ollama API implementation for integration tests.
// Endpoints used by Pinchy's provider-models.ts:
//   GET  /api/tags   → list models
//   POST /api/show   → model capabilities
// Endpoint used by OpenClaw when routing a chat message:
//   POST /api/chat   → streaming NDJSON response
import * as http from "http";

const MODEL_NAME = "fake-model:latest";
// This string must appear in the test's expect() assertion
const FAKE_RESPONSE = "Integration test response.";

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "";
  const method = req.method ?? "";

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
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const chunks = FAKE_RESPONSE.split(" ").map((word, i, arr) => ({
      model: MODEL_NAME,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: i === 0 ? word : " " + word },
      done: i === arr.length - 1,
      ...(i === arr.length - 1 && { done_reason: "stop", total_duration: 1000000 }),
    }));
    for (const chunk of chunks) {
      res.write(JSON.stringify(chunk) + "\n");
    }
    res.end();
    return;
  }

  // 404 for anything else
  res.writeHead(404);
  res.end();
}

export const FAKE_OLLAMA_PORT = 11435;
export const FAKE_OLLAMA_MODEL = `ollama/${MODEL_NAME}`;
export const FAKE_OLLAMA_RESPONSE = FAKE_RESPONSE;

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
