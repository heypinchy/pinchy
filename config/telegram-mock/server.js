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
    `openssl req -x509 -newkey rsa:2048 -keyout ${tmpDir}/key.pem -out ${tmpDir}/cert.pem -days 1 -nodes -subj "/CN=mock-api" -addext "subjectAltName=DNS:api.telegram.org,DNS:api.anthropic.com" 2>/dev/null`,
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
let fileIdCounter = 0;

// In-memory file store for getFile/download, keyed by file_id.
// file_id -> { file_path, file_unique_id, file_size, bytes: Buffer }
const mockFiles = new Map();

// A tiny deterministic "JPEG" — real magic bytes (SOI ffd8ff.. / EOI ffd9) so
// consumers checking Content-Type/signature are satisfied, but not a vendored
// image. Good enough for E2E to confirm bytes made it through the mock.
const MOCK_JPEG_BYTES = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb004300030202020203020203030303040604040404040805050405080b0908090909080b0d0f0f0c0c0f0d0d0e0e0e0e0effc9000b080001000103011100ffcc00060010ffda0008010100003f00ffd9",
  "hex",
);

// Registered bot tokens and their info
const bots = new Map();

// Pending updates for each bot (simulated incoming messages from users)
const pendingUpdates = new Map(); // token -> update[]

// Tokens whose bot has actually polled (called getUpdates at least once).
// Distinct from `bots` (registered via getMe) — a registered bot may not
// have started polling yet, especially during OpenClaw channel restarts
// when adding a second bot account. Tests use this to wait for a SPECIFIC
// bot to be live, instead of "any bot is registered".
//
// IMPORTANT: this set only ever GROWS (cleared only by /control/reset) — it
// answers "has this bot EVER polled", not "is it polling RIGHT NOW". It
// cannot detect a poller that stopped (e.g. after a Telegram channel
// disconnect); use `activePollingTokens` in the health snapshot for that.
const pollingTokens = new Set();

// Per-token count of getUpdates requests CURRENTLY in flight (an open long-poll
// connection). A live OpenClaw poller always keeps exactly one getUpdates
// request outstanding — it re-issues immediately on return — so `inflightPolls
// > 0` is a direct, latency-free signal that the bot is polling RIGHT NOW,
// independent of how long each individual long-poll lasts. When OpenClaw tears
// down a channel worker on disconnect it aborts the in-flight request; the HTTP
// layer catches the socket close and settles the poll, dropping the count to 0.
// Cleared by /control/reset.
const inflightPolls = new Map();

// Per-token timestamp (ms since epoch) of the most recent getUpdates begin or
// settle. Only used to bridge the sub-millisecond hand-off between one long-poll
// returning and OpenClaw re-issuing the next one, so a healthy poller never
// flickers out of the active set during that gap. Cleared by /control/reset.
const lastPollAt = new Map();

// After a poll settles and no request is left in flight, a token stays "active"
// for this grace period — just long enough to cover the re-issue hand-off plus
// CI scheduling jitter. It is deliberately SHORT and unrelated to the 30s
// long-poll timeout: that decoupling is the entire point. The previous
// freshness-only oracle stamped `lastPollAt` on COMPLETION and called a token
// active for FRESHNESS_MS afterwards, so the window had to exceed the 30s
// long-poll (else a healthy poller looked "stopped" mid-poll) — which in turn
// made a genuine stop undetectable for ~40s, far longer than the disconnect
// test's window. Tracking the in-flight connection instead means a healthy
// poller reads active via `inflightPolls` (not this grace), so the grace can be
// short and a real stop surfaces within it once the aborted poll settles.
const ACTIVE_GRACE_MS = 5000;

/**
 * Snapshot of poller state for GET /control/health. A token is "actively
 * polling" if it has a getUpdates request in flight right now, or settled one
 * within ACTIVE_GRACE_MS. `now` is injectable so unit tests can advance past
 * the grace window without a real sleep.
 */
function getHealthSnapshot(now = Date.now()) {
  const active = new Set();
  for (const [token, count] of inflightPolls) {
    if (count > 0) active.add(token);
  }
  for (const [token, ts] of lastPollAt) {
    if (now - ts < ACTIVE_GRACE_MS) active.add(token);
  }
  return {
    pollingTokens: [...pollingTokens],
    activePollingTokens: [...active],
  };
}

// Mark a getUpdates request as started/settled. `beginPoll` also records the
// bot in the ever-grew `pollingTokens` set (has this bot EVER polled), while
// `inflightPolls`/`lastPollAt` answer "is it polling right now".
function beginPoll(token) {
  pollingTokens.add(token);
  inflightPolls.set(token, (inflightPolls.get(token) || 0) + 1);
  lastPollAt.set(token, Date.now());
}

function endPoll(token) {
  const remaining = (inflightPolls.get(token) || 0) - 1;
  if (remaining > 0) inflightPolls.set(token, remaining);
  else inflightPolls.delete(token);
  lastPollAt.set(token, Date.now());
}

// When true, getUpdates returns HTTP-style 409 "Conflict: terminated by
// other getUpdates request" — the exact response Telegram sends when a
// SECOND deployment polls the same bot token. This drives OpenClaw's
// telegram channel into its crash/auto-restart loop so the channel-health
// detection can be exercised against a protocol-real failure. Toggled at
// runtime via POST /control/getUpdates409 so a test can capture the
// healthy → degraded transition. Per-token so other bots stay healthy.
const conflict409Tokens = new Set();
let conflict409All = false;

// Clear all per-test state. Mirrors POST /control/reset so the route and the
// unit test share one definition.
//
// IMPORTANT: `updateIdCounter` is deliberately NOT reset here. Real Telegram
// hands out `update_id` as a globally monotonic counter that never restarts,
// and an already-running getUpdates long-poll keeps its acknowledged offset
// across our resets (it does not re-call getMe). If we rewound the counter to
// a low value, freshly injected updates would carry an `update_id` below that
// stale offset and `handleGetUpdates` would silently filter them out — the bot
// would never see the message. Keeping the counter monotonic guarantees every
// post-reset update still exceeds any offset OpenClaw could be holding.
function resetState() {
  botResponses.length = 0;
  pendingUpdates.clear();
  bots.clear();
  pollingTokens.clear();
  inflightPolls.clear();
  lastPollAt.clear();
  conflict409Tokens.clear();
  conflict409All = false;
  // message_id may safely reset, unlike update_id: nothing filters on it
  // (botResponses is cleared and read back by timestamp), whereas a stale
  // long-poll offset filters incoming updates against update_id.
  messageIdCounter = 1000;
  // file_id/file_path likewise: getFile is a fresh lookup per test, not a
  // filtered/offset stream, so resetting is safe and keeps IDs small.
  fileIdCounter = 0;
  mockFiles.clear();
}

// ── Anthropic API mock (for model prewarm) ─────────────────────────────

function handleAnthropicRequest(url, body) {
  if (url === "/v1/models" || url.startsWith("/v1/models")) {
    return {
      data: [
        {
          id: "claude-haiku-4-5-20251001",
          type: "model",
          display_name: "Claude Haiku",
        },
        {
          id: "claude-sonnet-4-20250514",
          type: "model",
          display_name: "Claude Sonnet",
        },
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
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ── Bot API handlers ───────────────────────────────────────────────────

// Event emitter for notifying long-poll waiters when new updates arrive
const updateListeners = new Map(); // token -> callback[]

function notifyUpdateListeners(token) {
  const listeners = updateListeners.get(token) || [];
  updateListeners.set(token, []);
  for (const cb of listeners) cb();
}

// Build a Telegram `PhotoSize[]` for an inbound photo update: small -> large,
// each backed by a registered entry in `mockFiles` so a subsequent getFile +
// download round-trip resolves. Real Telegram sends several resized variants
// of the same photo (thumbnail, medium, original); two is enough to prove
// "array with distinct sizes, sorted small to large" without over-building.
const PHOTO_DIMENSIONS = [
  { width: 90, height: 90 },
  { width: 800, height: 600 },
];

function buildPhotoSizes() {
  return PHOTO_DIMENSIONS.map(({ width, height }) => {
    const n = ++fileIdCounter;
    const filePath = `photos/file_${n}.jpg`;
    const fileId = `mock-file-id-${n}`;
    const fileUniqueId = `mock-file-unique-${n}`;
    const bytes = MOCK_JPEG_BYTES;

    mockFiles.set(fileId, {
      file_path: filePath,
      file_unique_id: fileUniqueId,
      file_size: bytes.length,
      bytes,
    });

    return {
      file_id: fileId,
      file_unique_id: fileUniqueId,
      width,
      height,
      file_size: bytes.length,
    };
  });
}

// Simulate a user sending a message to the bot: build a Telegram update,
// queue it for the token's long-poll, and wake any waiting getUpdates. Shared
// by POST /control/sendMessage and the unit test. Returns the new update_id.
//
// `photo: true` builds a photo message (PhotoSize[] + optional caption)
// instead of a text message — mirrors real Telegram, where a message carries
// either `text` or `photo`/`caption`, never both.
function injectMessage({
  token,
  chatId,
  text,
  userId,
  username,
  firstName,
  lastName,
  photo,
  caption,
}) {
  const updateId = ++updateIdCounter;
  const message = {
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
  };

  if (photo) {
    message.photo = buildPhotoSizes();
    if (caption) message.caption = caption;
  } else {
    message.text = text;
  }

  const update = { update_id: updateId, message };

  if (!pendingUpdates.has(token)) {
    pendingUpdates.set(token, []);
  }
  pendingUpdates.get(token).push(update);

  // Notify any long-polling getUpdates requests
  notifyUpdateListeners(token);

  return updateId;
}

// getUpdates is async (long-poll) — handled separately.
//
// `options.signal` (optional AbortSignal) lets the HTTP layer cancel an
// in-flight long-poll when the client closes the connection — e.g. OpenClaw
// aborting the request as it tears down a disconnected bot's channel worker.
// Cancelling settles the poll so `inflightPolls` drops to 0 promptly, which is
// what makes "the poller stopped" observable within ACTIVE_GRACE_MS rather than
// only after a full 30s long-poll timeout (Issue #476 Gap 1).
async function handleGetUpdates(token, body, options = {}) {
  const { signal } = options;
  // Mark this bot as actively polling (both the ever-grew `pollingTokens` set
  // and the in-flight counter). `endPoll` in the finally clears the in-flight
  // count on every exit path — 409, immediate return, timeout, update, abort.
  beginPoll(token);
  try {
    // Simulated duplicate-poller conflict: Telegram returns 409 when a second
    // instance polls the same token. Return it immediately (no long-poll) so
    // OpenClaw's channel worker exits and the health-monitor restart loop kicks
    // in — the exact production failure mode for cross-environment bot sharing.
    if (conflict409All || conflict409Tokens.has(token)) {
      return {
        ok: false,
        error_code: 409,
        description:
          "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
      };
    }

    const timeout = Math.min(parseInt(body?.timeout || "30", 10), 30);
    const offset = parseInt(body?.offset || "0", 10);

    // Check for existing updates
    const updates = pendingUpdates.get(token) || [];
    if (offset > 0) {
      // Clear consumed updates
      pendingUpdates.set(
        token,
        updates.filter((u) => u.update_id >= offset),
      );
    }

    const filtered = (pendingUpdates.get(token) || []).filter(
      (u) => u.update_id >= offset,
    );

    if (filtered.length > 0) {
      return { ok: true, result: filtered };
    }

    // Long-poll: wait for new updates, timeout, or client abort.
    return await new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        const listeners = updateListeners.get(token) || [];
        updateListeners.set(
          token,
          listeners.filter((cb) => cb !== onUpdate),
        );
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ ok: true, result: [] });
      }, timeout * 1000);
      const onUpdate = () => {
        cleanup();
        const current = (pendingUpdates.get(token) || []).filter(
          (u) => u.update_id >= offset,
        );
        resolve({ ok: true, result: current });
      };
      // Client (OpenClaw) closed the request — e.g. its channel worker is being
      // torn down on disconnect. Settle now so the in-flight count drops instead
      // of lingering until the full long-poll timeout fires (and stamps a
      // "zombie" completion 30s in the future).
      const onAbort = () => {
        cleanup();
        resolve({ ok: true, result: [] });
      };
      if (signal) {
        if (signal.aborted) {
          cleanup();
          resolve({ ok: true, result: [] });
          return;
        }
        signal.addEventListener("abort", onAbort);
      }
      if (!updateListeners.has(token)) {
        updateListeners.set(token, []);
      }
      updateListeners.get(token).push(onUpdate);
    });
  } finally {
    endPoll(token);
  }
}

// Wire an HTTP request/response to a getUpdates long-poll, cancelling the poll
// if the client closes the connection before we answer — so a torn-down
// poller's in-flight count drops promptly (Issue #476 Gap 1) instead of waiting
// out the 30s long-poll. `res` "close" fires on abort AND on normal completion;
// aborting an already-settled poll is a harmless no-op.
function dispatchGetUpdates(req, res, token, body) {
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  handleGetUpdates(token, body, { signal: ac.signal }).then((result) => {
    if (res.writableEnded) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });
}

// Look up the raw bytes for a file previously registered via a photo update,
// by the `file_path` returned from getFile. Used by the GET
// /file/bot<token>/<file_path> download route (and directly by unit tests).
function getFileBytes(filePath) {
  for (const file of mockFiles.values()) {
    if (file.file_path === filePath) return file.bytes;
  }
  return null;
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

    case "getFile": {
      const file = mockFiles.get(body?.file_id);
      if (!file) {
        return {
          ok: false,
          error_code: 400,
          description: "Bad Request: invalid file_id",
        };
      }
      return {
        ok: true,
        result: {
          file_id: body.file_id,
          file_unique_id: file.file_unique_id,
          file_size: file.file_size,
          file_path: file.file_path,
        },
      };
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

// Handle GET /file/bot<token>/<file_path> — the grammY/Bot API file download
// route (distinct from /bot<token>/<method>, which POSTs JSON RPC-style
// calls). Returns true if it handled the request. Shared between the HTTPS
// Bot API port and the control port so both mirror real Telegram's surface.
function dispatchFileDownload(req, res) {
  const match = req.url.match(/^\/file\/bot([^/]+)\/(.+)$/);
  if (!match) return false;

  const [, , filePath] = match;
  const bytes = getFileBytes(decodeURIComponent(filePath));
  if (!bytes) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }),
    );
    return true;
  }

  res.writeHead(200, { "Content-Type": "image/jpeg" });
  res.end(bytes);
  return true;
}

// ── HTTPS proxy (port 443) — serves the Bot API ───────────────────────

function startHttpsServer(cert) {
  const server = https.createServer(cert, (req, res) => {
    console.log(`[telegram-mock] HTTPS ${req.method} ${req.url}`);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("error", (err) =>
      console.error(`[telegram-mock] HTTPS request error: ${err.message}`),
    );
    req.on("end", () => {
      // Handle Anthropic API requests (model prewarm and chat)
      if (req.url.startsWith("/v1/")) {
        const result = handleAnthropicRequest(req.url, parsedBody(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // GET /file/bot<token>/<file_path> — grammY's getFile download step
      if (req.method === "GET" && dispatchFileDownload(req, res)) {
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

      console.log(
        `[telegram-mock] HTTPS ${method} from bot ${token.substring(0, 10)}...`,
      );

      // getUpdates is async (long-poll)
      if (method === "getUpdates") {
        dispatchGetUpdates(req, res, token, bodyData);
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

      // POST /control/sendMessage — simulate user sending a message to bot.
      // `{ photo: true, caption? }` queues a photo update instead of text
      // (mirrors real Telegram: a message carries text OR photo, not both).
      if (req.method === "POST" && url.pathname === "/control/sendMessage") {
        const opts = JSON.parse(body);

        if (!opts.token || !opts.chatId || !(opts.text || opts.photo)) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error: "token, chatId, and text or photo required",
            }),
          );
          return;
        }

        const updateId = injectMessage(opts);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, updateId }));
        // Strip CR/LF from the user-provided values before logging (CodeQL
        // js/log-injection — it only recognises an explicit newline replace).
        const safeChatId = String(opts.chatId).replace(/[\r\n]/g, "");
        const safeText = String(opts.photo ? "[photo]" : opts.text).replace(
          /[\r\n]/g,
          "",
        );
        console.log(
          `[telegram-mock] Injected message from user ${safeChatId}: "${safeText}"`,
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
            (r) => String(r.chatId) === String(chatId),
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
        resetState();
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        console.log("[telegram-mock] State reset");
        return;
      }

      // POST /control/getUpdates409 — toggle the duplicate-poller 409 conflict.
      // Body: { enabled: bool, token?: string }. With a token it targets just
      // that bot; without, it applies to all tokens.
      if (req.method === "POST" && url.pathname === "/control/getUpdates409") {
        const { enabled, token } = JSON.parse(body || "{}");
        if (token) {
          if (enabled) conflict409Tokens.add(token);
          else conflict409Tokens.delete(token);
        } else {
          conflict409All = !!enabled;
        }
        res.writeHead(200);
        res.end(
          JSON.stringify({
            ok: true,
            conflict409All,
            conflict409Tokens: [...conflict409Tokens],
          }),
        );
        // Strip CR/LF from the user-provided token before logging (CodeQL
        // js/log-injection — it only recognises an explicit newline replace).
        const safeToken = token
          ? String(token)
              .slice(0, 10)
              .replace(/[\r\n]/g, "")
          : "";
        console.log(
          `[telegram-mock] getUpdates409 ${enabled ? "ENABLED" : "disabled"}${token ? ` for ${safeToken}...` : " (all)"}`,
        );
        return;
      }

      // GET /control/health
      if (req.method === "GET" && url.pathname === "/control/health") {
        const { pollingTokens: pollingTokensSnapshot, activePollingTokens } =
          getHealthSnapshot();
        res.writeHead(200);
        res.end(
          JSON.stringify({
            ok: true,
            bots: [...bots.keys()].length,
            pollingTokens: pollingTokensSnapshot,
            activePollingTokens,
            pendingUpdates: [...pendingUpdates.values()].flat().length,
            responses: botResponses.length,
            conflict409All,
            conflict409Tokens: [...conflict409Tokens],
          }),
        );
        return;
      }

      // GET /file/bot<token>/<file_path> — also mirrored on this port
      if (req.method === "GET" && dispatchFileDownload(req, res)) {
        return;
      }

      // Also handle Bot API on this port (for Pinchy's validateTelegramBotToken)
      const botMatch = req.url.match(/^\/bot([^/]+)\/(\w+)/);
      if (botMatch) {
        const [, token, method] = botMatch;
        const botBody = parsedBody(body);
        if (method === "getUpdates") {
          dispatchGetUpdates(req, res, token, botBody);
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

// Only boot the servers when run directly (node server.js / Docker CMD).
// When required from a unit test we just want the pure handlers below, with
// no ports bound (443 is privileged and unavailable outside the container).
if (require.main === module) {
  main().catch((err) => {
    console.error("[telegram-mock] Fatal:", err);
    process.exit(1);
  });
}

module.exports = {
  resetState,
  injectMessage,
  handleGetUpdates,
  handleBotRequest,
  getFileBytes,
  getHealthSnapshot,
  ACTIVE_GRACE_MS,
};
