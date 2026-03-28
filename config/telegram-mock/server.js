/**
 * Mock Telegram Bot API server for E2E testing.
 *
 * Wraps telegram-test-api with:
 * 1. HTTPS on port 443 (self-signed cert for api.telegram.org)
 * 2. Control API on port 9001 for tests to inject messages and read responses
 *
 * OpenClaw resolves api.telegram.org to this container via Docker DNS override.
 */

const https = require("https");
const http = require("http");
// ── Self-signed cert for api.telegram.org ──────────────────────────────

function generateSelfSignedCert() {
  const { execSync } = require("child_process");
  const tmpDir = "/tmp/telegram-mock-certs";
  execSync(`mkdir -p ${tmpDir}`);
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${tmpDir}/key.pem -out ${tmpDir}/cert.pem -days 1 -nodes -subj "/CN=mock-api" -addext "subjectAltName=DNS:api.telegram.org,DNS:api.anthropic.com" 2>/dev/null`
  );
  const fs = require("fs");
  return {
    key: fs.readFileSync(`${tmpDir}/key.pem`),
    cert: fs.readFileSync(`${tmpDir}/cert.pem`),
  };
}

// ── State ──────────────────────────────────────────────────────────────

const botResponses = []; // Messages sent BY the bot (via sendMessage)
let messageIdCounter = 1000;
let updateIdCounter = 100;

// Registered bot tokens and their info
const bots = new Map();

// Pending updates for each bot (simulated incoming messages from users)
const pendingUpdates = new Map(); // token -> update[]

// ── Anthropic API mock (for model prewarm) ─────────────────────────────

function handleAnthropicRequest(url, body) {
  if (url === "/v1/models" || url.startsWith("/v1/models")) {
    return {
      data: [
        { id: "claude-haiku-4-5-20251001", type: "model", display_name: "Claude Haiku" },
        { id: "claude-sonnet-4-20250514", type: "model", display_name: "Claude Sonnet" },
      ],
      has_more: false,
    };
  }
  if (url === "/v1/messages") {
    return {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Mock response from test server." }],
      model: body?.model || "claude-haiku-4-5-20251001",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }
  return { error: { type: "not_found", message: "Unknown endpoint" } };
}

function parsedBody(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ── Bot API handlers ───────────────────────────────────────────────────

// Event emitter for notifying long-poll waiters when new updates arrive
const updateListeners = new Map(); // token -> callback[]

function notifyUpdateListeners(token) {
  const listeners = updateListeners.get(token) || [];
  updateListeners.set(token, []);
  for (const cb of listeners) cb();
}

// getUpdates is async (long-poll) — handled separately
async function handleGetUpdates(token, body) {
  const timeout = Math.min(parseInt(body?.timeout || "30", 10), 30);
  const offset = parseInt(body?.offset || "0", 10);

  // Check for existing updates
  const updates = pendingUpdates.get(token) || [];
  if (offset > 0) {
    // Clear consumed updates
    pendingUpdates.set(token, updates.filter((u) => u.update_id >= offset));
  }

  const filtered = (pendingUpdates.get(token) || []).filter(
    (u) => u.update_id >= offset
  );

  if (filtered.length > 0) {
    return { ok: true, result: filtered };
  }

  // Long-poll: wait for new updates or timeout
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Remove this listener
      const listeners = updateListeners.get(token) || [];
      updateListeners.set(
        token,
        listeners.filter((cb) => cb !== onUpdate)
      );
      resolve({ ok: true, result: [] });
    }, timeout * 1000);

    const onUpdate = () => {
      clearTimeout(timer);
      const current = (pendingUpdates.get(token) || []).filter(
        (u) => u.update_id >= offset
      );
      resolve({ ok: true, result: current });
    };

    if (!updateListeners.has(token)) {
      updateListeners.set(token, []);
    }
    updateListeners.get(token).push(onUpdate);
  });
}

function handleBotRequest(token, method, body) {
  switch (method) {
    case "getMe": {
      const bot = bots.get(token);
      if (!bot) {
        // Auto-register bot on first getMe
        const botId = Math.floor(Math.random() * 900000000) + 100000000;
        const botInfo = {
          id: botId,
          is_bot: true,
          first_name: "TestBot",
          username: `test_bot_${botId}`,
        };
        bots.set(token, botInfo);
        return { ok: true, result: botInfo };
      }
      return { ok: true, result: bot };
    }

    case "sendMessage": {
      const msgId = ++messageIdCounter;
      const response = {
        message_id: msgId,
        chat: { id: body.chat_id, type: "private" },
        text: body.text,
        date: Math.floor(Date.now() / 1000),
        from: bots.get(token) || { id: 0, is_bot: true, first_name: "Bot" },
      };
      botResponses.push({
        token,
        chatId: body.chat_id,
        text: body.text,
        messageId: msgId,
        timestamp: new Date().toISOString(),
      });
      return { ok: true, result: response };
    }

    case "deleteWebhook":
      return { ok: true, result: true };

    case "getWebhookInfo":
      return { ok: true, result: { url: "", has_custom_certificate: false } };

    default:
      // Return a generic success for unhandled methods
      return { ok: true, result: true };
  }
}

// ── HTTPS proxy (port 443) — serves the Bot API ───────────────────────

function startHttpsServer(cert) {
  const server = https.createServer(cert, (req, res) => {
    console.log(`[telegram-mock] HTTPS ${req.method} ${req.url}`);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("error", (err) => console.error(`[telegram-mock] HTTPS request error: ${err.message}`));
    req.on("end", () => {
      // Handle Anthropic API requests (model prewarm and chat)
      if (req.url.startsWith("/v1/")) {
        const result = handleAnthropicRequest(req.url, parsedBody(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // Parse /bot<token>/<method>
      const match = req.url.match(/^\/bot([^/]+)\/(\w+)/);
      if (!match) {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, description: "Not Found" }));
        return;
      }

      const [, token, method] = match;
      let bodyData = parsedBody(body);

      console.log(`[telegram-mock] HTTPS ${method} from bot ${token.substring(0, 10)}...`);

      // getUpdates is async (long-poll)
      if (method === "getUpdates") {
        handleGetUpdates(token, bodyData).then((result) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        });
        return;
      }

      const result = handleBotRequest(token, method, bodyData);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
  });

  server.on("tlsClientError", (err) => {
    console.error(`[telegram-mock] TLS client error: ${err.message}`);
  });

  server.listen(443, "0.0.0.0", () => {
    console.log("[telegram-mock] HTTPS Bot API listening on :443");
  });

  return server;
}

// ── Control API (port 9001) — for tests to inject/read messages ───────

function startControlServer() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      res.setHeader("Content-Type", "application/json");

      // POST /control/sendMessage — simulate user sending a message to bot
      if (req.method === "POST" && url.pathname === "/control/sendMessage") {
        const { token, chatId, text, userId, username, firstName, lastName } =
          JSON.parse(body);

        if (!token || !chatId || !text) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "token, chatId, and text required" }));
          return;
        }

        const updateId = ++updateIdCounter;
        const update = {
          update_id: updateId,
          message: {
            message_id: ++messageIdCounter,
            from: {
              id: parseInt(userId || chatId),
              is_bot: false,
              first_name: firstName || "TestUser",
              last_name: lastName || "",
              username: username || "testuser",
            },
            chat: {
              id: parseInt(chatId),
              type: "private",
              first_name: firstName || "TestUser",
              last_name: lastName || "",
              username: username || "testuser",
            },
            date: Math.floor(Date.now() / 1000),
            text,
          },
        };

        if (!pendingUpdates.has(token)) {
          pendingUpdates.set(token, []);
        }
        pendingUpdates.get(token).push(update);

        // Notify any long-polling getUpdates requests
        notifyUpdateListeners(token);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, updateId }));
        console.log(
          `[telegram-mock] Injected message from user ${chatId}: "${text}"`
        );
        return;
      }

      // GET /control/responses — read bot responses
      if (req.method === "GET" && url.pathname === "/control/responses") {
        const chatId = url.searchParams.get("chatId");
        const since = url.searchParams.get("since");
        let filtered = botResponses;
        if (chatId) {
          filtered = filtered.filter(
            (r) => String(r.chatId) === String(chatId)
          );
        }
        if (since) {
          filtered = filtered.filter((r) => r.timestamp > since);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, responses: filtered }));
        return;
      }

      // POST /control/reset — clear all state
      if (req.method === "POST" && url.pathname === "/control/reset") {
        botResponses.length = 0;
        pendingUpdates.clear();
        bots.clear();
        messageIdCounter = 1000;
        updateIdCounter = 100;
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        console.log("[telegram-mock] State reset");
        return;
      }

      // GET /control/health
      if (req.method === "GET" && url.pathname === "/control/health") {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            ok: true,
            bots: [...bots.keys()].length,
            pendingUpdates: [...pendingUpdates.values()].flat().length,
            responses: botResponses.length,
          })
        );
        return;
      }

      // Also handle Bot API on this port (for Pinchy's validateTelegramBotToken)
      const botMatch = req.url.match(/^\/bot([^/]+)\/(\w+)/);
      if (botMatch) {
        const [, token, method] = botMatch;
        const botBody = parsedBody(body);
        if (method === "getUpdates") {
          handleGetUpdates(token, botBody).then((result) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          });
          return;
        }
        const result = handleBotRequest(token, method, botBody);
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    });
  });

  server.listen(9001, "0.0.0.0", () => {
    console.log("[telegram-mock] Control API listening on :9001");
  });

  return server;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log("[telegram-mock] Generating self-signed certificate...");
  const cert = generateSelfSignedCert();

  startHttpsServer(cert);
  startControlServer();

  console.log("[telegram-mock] Ready");
}

main().catch((err) => {
  console.error("[telegram-mock] Fatal:", err);
  process.exit(1);
});
