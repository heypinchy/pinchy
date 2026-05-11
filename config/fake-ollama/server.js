// config/fake-ollama/server.js
//
// Minimal Ollama-compatible server for the email E2E Docker stack.
//
// Handles both the Ollama-native chat path (used by OpenClaw via api:
// "openai-completions" as evidenced by the integration test server) and the
// OpenAI-compatible path, plus the model-discovery endpoints Pinchy calls
// during config generation:
//
//   GET  /api/tags              → model list
//   POST /api/show              → capabilities
//   POST /api/chat              → Ollama-native NDJSON streaming (primary path)
//   POST /v1/chat/completions   → OpenAI-compatible (SSE / JSON, fallback)
//
// Trigger strings in the last user message select the response:
//   E2E_EMAIL_LIST_TOOL  → tool_call: email_list({ folder: "INBOX" })
//   E2E_EMAIL_SEND_TOOL  → tool_call: email_send({ to, subject, body })
//   (default / after tool result) → plain text response
import * as http from "http";
import * as crypto from "crypto";

const PORT = 11435;
const MODEL_NAME = "llama3.2";
const FAKE_RESPONSE = "Integration test response.";
const EMAIL_LIST_TRIGGER = "E2E_EMAIL_LIST_TOOL";
const EMAIL_LIST_RESPONSE = "Email list tool call completed.";
const EMAIL_SEND_TRIGGER = "E2E_EMAIL_SEND_TOOL";
const EMAIL_SEND_RESPONSE = "Email send tool call completed.";

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

function messageContent(message) {
  if (!message || typeof message !== "object") return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => p?.text ?? "").join("");
  }
  return "";
}

function hasToolRole(messages) {
  return messages.some((m) => m?.role === "tool");
}

function makeId() {
  return `chatcmpl-${crypto.randomBytes(6).toString("hex")}`;
}

// --- Ollama-native NDJSON helpers (POST /api/chat) ---

function writeNdjson(res, chunks) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  for (const chunk of chunks) {
    res.write(JSON.stringify(chunk) + "\n");
  }
  res.end();
}

function ollamaStreamText(res, text) {
  const words = text.split(" ");
  const chunks = words.map((word, i) => ({
    model: MODEL_NAME,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content: i === 0 ? word : " " + word },
    done: i === words.length - 1,
    ...(i === words.length - 1 && { done_reason: "stop", total_duration: 1000000 }),
  }));
  writeNdjson(res, chunks);
}

function ollamaToolCall(res, toolName, toolArgs) {
  writeNdjson(res, [
    {
      model: MODEL_NAME,
      created_at: new Date().toISOString(),
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: toolName, arguments: toolArgs } }],
      },
      done: true,
      done_reason: "stop",
      total_duration: 1000000,
    },
  ]);
}

// --- OpenAI-compatible SSE helpers (POST /v1/chat/completions) ---

function writeStreamChunk(res, id, delta, finishReason) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    model: MODEL_NAME,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function startSseResponse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function openaiStreamText(res, text) {
  const id = makeId();
  startSseResponse(res);
  const words = text.split(" ");
  words.forEach((word, i) => {
    writeStreamChunk(res, id, { role: "assistant", content: i === 0 ? word : ` ${word}` }, null);
  });
  writeStreamChunk(res, id, {}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

function openaiStreamToolCall(res, toolName, toolArgs) {
  const id = makeId();
  const callId = `call_${crypto.randomBytes(4).toString("hex")}`;
  startSseResponse(res);
  writeStreamChunk(
    res,
    id,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { index: 0, id: callId, type: "function", function: { name: toolName, arguments: "" } },
      ],
    },
    null
  );
  writeStreamChunk(
    res,
    id,
    { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolArgs) } }] },
    null
  );
  writeStreamChunk(res, id, {}, "tool_calls");
  res.write("data: [DONE]\n\n");
  res.end();
}

function openaiJsonText(res, text) {
  const body = {
    id: makeId(),
    object: "chat.completion",
    model: MODEL_NAME,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function openaiJsonToolCall(res, toolName, toolArgs) {
  const body = {
    id: makeId(),
    object: "chat.completion",
    model: MODEL_NAME,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${crypto.randomBytes(4).toString("hex")}`,
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(toolArgs) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// --- Shared trigger logic ---

function resolveTriggers(messages) {
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const userText = messageContent(lastUser);
  const toolResultPresent = hasToolRole(messages);
  return {
    isEmailList: userText.includes(EMAIL_LIST_TRIGGER),
    isEmailSend: userText.includes(EMAIL_SEND_TRIGGER),
    toolResultPresent,
  };
}

function responseText(isEmailList, isEmailSend) {
  if (isEmailList) return EMAIL_LIST_RESPONSE;
  if (isEmailSend) return EMAIL_SEND_RESPONSE;
  return FAKE_RESPONSE;
}

// --- Request handler ---

async function handleRequest(req, res) {
  const { url, method } = req;
  console.log(`[fake-ollama] ${method} ${url}`);

  if (method === "GET" && url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: MODEL_NAME, details: { parameter_size: "1B" } }] }));
    return;
  }

  if (method === "POST" && url === "/api/show") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ capabilities: ["completion", "tools"], details: { parameter_size: "1B" } })
    );
    return;
  }

  // Ollama-native chat path — used by OpenClaw's "openai-completions" provider
  // (despite the name, OpenClaw routes via /api/chat with the Ollama NDJSON format).
  if (method === "POST" && url === "/api/chat") {
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const { isEmailList, isEmailSend, toolResultPresent } = resolveTriggers(messages);

    if (isEmailList && !toolResultPresent) {
      ollamaToolCall(res, "email_list", { folder: "INBOX" });
      return;
    }
    if (isEmailSend && !toolResultPresent) {
      ollamaToolCall(res, "email_send", {
        to: "test@example.com",
        subject: "E2E test email",
        body: "This is a test email from the E2E suite.",
      });
      return;
    }
    ollamaStreamText(res, responseText(isEmailList, isEmailSend));
    return;
  }

  // OpenAI-compatible chat path (kept as fallback in case OpenClaw routes here).
  if (method === "POST" && url === "/v1/chat/completions") {
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const useStream = body.stream !== false;
    const { isEmailList, isEmailSend, toolResultPresent } = resolveTriggers(messages);

    if (isEmailList && !toolResultPresent) {
      if (useStream) {
        openaiStreamToolCall(res, "email_list", { folder: "INBOX" });
      } else {
        openaiJsonToolCall(res, "email_list", { folder: "INBOX" });
      }
      return;
    }
    if (isEmailSend && !toolResultPresent) {
      const args = {
        to: "test@example.com",
        subject: "E2E test email",
        body: "This is a test email from the E2E suite.",
      };
      if (useStream) {
        openaiStreamToolCall(res, "email_send", args);
      } else {
        openaiJsonToolCall(res, "email_send", args);
      }
      return;
    }
    const text = responseText(isEmailList, isEmailSend);
    if (useStream) {
      openaiStreamText(res, text);
    } else {
      openaiJsonText(res, text);
    }
    return;
  }

  console.log(`[fake-ollama] 404 — unhandled: ${method} ${url}`);
  res.writeHead(404);
  res.end();
}

const server = http.createServer(handleRequest);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[fake-ollama] listening on port ${PORT}`);
});
