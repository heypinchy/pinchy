/**
 * Minimal OpenAI-compatible fake LLM server used by the usage-tracking
 * integration test. It responds to any POST with a fixed chat-completion
 * payload whose `usage` block carries known token counts — so the test
 * can assert "X prompt_tokens in → X recorded on dashboard out" without
 * depending on a real model provider.
 *
 * This file is a helper for `usage-tracking.integration.test.ts`; it is
 * not itself a test suite. Vitest ignores files without `.test.ts` in
 * the default run.
 */

import { createServer, type Server } from "http";

export interface FakeLlmConfig {
  port: number;
  responseText: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Starts a fake OpenAI-compatible server on the given port and resolves
 * with the underlying Node `Server` handle once it is listening. Call
 * `server.close()` (typically in an `afterAll`) to release the port.
 */
export function startFakeLlmServer(config: FakeLlmConfig): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // Consume the request body so the connection closes cleanly; we
      // don't actually need it for the canned response.
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "fake-completion",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "fake-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: config.responseText,
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: config.promptTokens,
              completion_tokens: config.completionTokens,
              total_tokens: config.promptTokens + config.completionTokens,
            },
          })
        );
      });
    });
    server.listen(config.port, () => resolve(server));
  });
}
