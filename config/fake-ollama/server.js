// config/fake-ollama/server.js
//
// Minimal Ollama-compatible server for the email E2E Docker stack.
//
// Implements the OpenAI-compatible endpoint that OpenClaw uses when
// Pinchy configures `api: "openai-completions"` for the ollama-local provider:
//   GET  /api/tags              → model list (for Pinchy's model discovery)
//   POST /api/show              → model capabilities
//   POST /v1/chat/completions   → chat (OpenAI-compatible, streaming + non-streaming)
//
// Trigger strings in the last user message select the response type:
//   E2E_EMAIL_LIST_TOOL  → tool_call: email_list({ folder: "INBOX" })
//   E2E_EMAIL_SEND_TOOL  → tool_call: email_send({ to, subject, body })
//   (default)            → plain text: "Integration test response."
//
// After a tool result is present (role: "tool" in messages), the server
// returns the appropriate follow-up text response.
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

// --- Streaming (SSE) helpers ---

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

function streamText(res, text) {
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

function streamToolCall(res, toolName, toolArgs) {
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

// --- Non-streaming (JSON) helpers ---

function jsonText(res, text) {
  const body = {
    id: makeId(),
    object: "chat.completion",
    model: MODEL_NAME,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonToolCall(res, toolName, toolArgs) {
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

// --- Request handler ---

async function handleRequest(req, res) {
  const { url, method } = req;

  if (method === "GET" && url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        models: [{ name: MODEL_NAME, details: { parameter_size: "1B" } }],
      })
    );
    return;
  }

  if (method === "POST" && url === "/api/show") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        capabilities: ["completion", "tools"],
        details: { parameter_size: "1B" },
      })
    );
    return;
  }

  if (method === "POST" && url === "/v1/chat/completions") {
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const useStream = body.stream !== false;

    const lastUser = [...messages].reverse().find((m) => m?.role === "user");
    const userText = messageContent(lastUser);
    const toolResultPresent = hasToolRole(messages);

    const isEmailList = userText.includes(EMAIL_LIST_TRIGGER);
    const isEmailSend = userText.includes(EMAIL_SEND_TRIGGER);

    if (isEmailList && !toolResultPresent) {
      if (useStream) {
        streamToolCall(res, "email_list", { folder: "INBOX" });
      } else {
        jsonToolCall(res, "email_list", { folder: "INBOX" });
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
        streamToolCall(res, "email_send", args);
      } else {
        jsonToolCall(res, "email_send", args);
      }
      return;
    }

    // Default: plain text response (also used after tool round-trips)
    const responseText = isEmailList
      ? EMAIL_LIST_RESPONSE
      : isEmailSend
        ? EMAIL_SEND_RESPONSE
        : FAKE_RESPONSE;
    if (useStream) {
      streamText(res, responseText);
    } else {
      jsonText(res, responseText);
    }
    return;
  }

  res.writeHead(404);
  res.end();
}

const server = http.createServer(handleRequest);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[fake-ollama] listening on port ${PORT}`);
});
