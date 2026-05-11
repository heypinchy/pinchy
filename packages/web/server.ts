import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { OpenClawClient } from "openclaw-node";
import { ClientRouter } from "./src/server/client-router";
import { SessionCache } from "./src/server/session-cache";
import { validateWsSession } from "./src/server/ws-auth";
import { restartState } from "./src/server/restart-state";
import { openClawConnectionState } from "./src/server/openclaw-connection-state";
import { setOpenClawClient } from "./src/server/openclaw-client";
import { WsRateLimiter } from "./src/server/ws-rate-limit";
import { setupOpenClawDisconnectHandler } from "./src/server/openclaw-disconnect-handler";
import {
  setupOpenClawStatusBroadcaster,
  createColdStartStatusBroadcaster,
} from "./src/server/openclaw-status-broadcaster";
import { logCapture } from "./src/lib/log-capture";
import { startUsagePoller, stopUsagePoller } from "./src/lib/usage-poller";
import { registerShutdownHandlers } from "./src/lib/shutdown";
import { seedSessionCache } from "./src/server/session-cache-seeder";
import { readGatewayToken } from "./src/lib/gateway-token-reader";
import { getBetterAuthUrlStartupWarning } from "./src/lib/auth-env-warning";
import { regenerateOpenClawConfig } from "./src/lib/openclaw-config";
import { SERVER_WS_MAX_PAYLOAD_BYTES } from "./src/lib/limits";

logCapture.install();

const betterAuthUrlWarning = getBetterAuthUrlStartupWarning();
if (betterAuthUrlWarning) console.warn(betterAuthUrlWarning);

if (process.env.PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT === "1") {
  // Surface this loud at startup. Production deployments must NEVER set this
  // — it disables Better Auth's brute-force protection on /sign-in/*. The
  // only legitimate setter is docker-compose.e2e.yml, which is itself only
  // ever layered on top of docker-compose.yml during CI E2E runs.
  console.warn(
    "⚠ PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT=1 — auth rate limiting is OFF. " +
      "This must only ever be set in E2E test stacks. If you see this in " +
      "production logs, unset the env var and restart immediately."
  );
}

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

const OPENCLAW_WS_URL = process.env.OPENCLAW_WS_URL;

async function waitForGatewayToken(maxWaitMs = 30000): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const token = readGatewayToken();
    if (token) return token;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

if (process.env.NODE_ENV === "production") {
  const dbUrl = process.env.DATABASE_URL || "";
  if (dbUrl.includes(":pinchy_dev@")) {
    console.warn(
      "WARNING: Using default DB_PASSWORD. Set a secure password via .env for production."
    );
  }
}

app.prepare().then(async () => {
  // Import request-handling modules before the server starts — these don't
  // depend on bootInits having run (domain cache starts empty and fills lazily).
  const { isHostAllowed } = await import("./src/server/host-check");
  const { getCachedDomain } = await import("./src/lib/domain-cache");
  const { applyCsrfGate } = await import("./src/server/csrf-check");

  const server = createServer(async (req, res) => {
    const { pathname } = parse(req.url!, true);
    const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
    if (!isHostAllowed(host, pathname)) {
      const accept = req.headers.accept || "";
      if (accept.includes("text/html")) {
        const domain = getCachedDomain();
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access Denied — Pinchy</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
.card{max-width:420px;padding:2rem;text-align:center}.icon{font-size:2rem;margin-bottom:1rem}h1{font-size:1.25rem;margin:0 0 .75rem}
p{color:#a3a3a3;font-size:.875rem;line-height:1.5;margin:0 0 1rem}a{color:#f59e0b;text-decoration:none}a:hover{text-decoration:underline}</style></head>
<body><div class="card"><div class="icon">🔒</div><h1>Access Denied</h1>
<p>This Pinchy instance is locked to a specific domain. You're accessing it from an address that isn't allowed.</p>
${domain ? `<p><a href="https://${domain}">Go to ${domain} →</a></p>` : ""}
</div></body></html>`);
      } else {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Forbidden: request host does not match the configured domain" })
        );
      }
      return;
    }

    if (await applyCsrfGate(req, res)) return;

    handle(req, res, parse(req.url!, true));
  });

  let openclawClient: OpenClawClient | null = null;
  // Pre-construct a cold-start stand-in so the WS server always has a
  // broadcaster to call. Belt-and-suspenders for issue #198: even if a
  // future client change reintroduces an optimistic default, a browser
  // connecting before the OpenClaw block has run still receives an
  // honest `openclaw_status: false` frame.
  let statusBroadcaster: ReturnType<typeof setupOpenClawStatusBroadcaster> =
    createColdStartStatusBroadcaster();

  const sessionCache = new SessionCache();

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: SERVER_WS_MAX_PAYLOAD_BYTES,
  });
  const sessionMap = new Map<WebSocket, { userId: string; userRole: string }>();
  const wsRateLimiter = new WsRateLimiter({
    onReject: (reason) => {
      // Surface every limiter rejection at warn level so silent throttling
      // cannot mask UI reconnect bugs (the reason this hook exists).
      if (reason.kind === "upgrade") {
        console.warn(`[ws] rate-limited WebSocket upgrade from ip=${reason.ip}`);
      } else {
        console.warn(
          `[ws] rate-limited WebSocket connection for user=${reason.userId} (max concurrent reached)`
        );
      }
    },
  });

  function broadcastToClients(message: Record<string, unknown>) {
    const payload = JSON.stringify(message);
    for (const [clientWs] of sessionMap) {
      if (clientWs.readyState === 1) clientWs.send(payload);
    }
  }

  restartState.on("restarting", () => broadcastToClients({ type: "openclaw:restarting" }));
  restartState.on("ready", () => broadcastToClients({ type: "openclaw:ready" }));

  server.on("upgrade", async (request, socket, head) => {
    const { pathname } = parse(request.url!, true);
    if (pathname === "/api/ws") {
      // Rate limit by IP before doing any auth work. The limiter's onReject
      // hook (configured above) takes care of warn-level logging.
      const ip = request.socket.remoteAddress ?? "unknown";
      if (!wsRateLimiter.allowUpgrade(ip)) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        socket.destroy();
        return;
      }

      const sessionInfo = await validateWsSession(request.headers.cookie);
      if (!sessionInfo) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      // Limit concurrent connections per user
      const { userId, userRole } = sessionInfo;
      if (!wsRateLimiter.allowConnection(userId)) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wsRateLimiter.trackConnection(userId);
        sessionMap.set(ws, { userId, userRole });
        wss.emit("connection", ws, request);
      });
    }
    // Other upgrade requests (e.g. Next.js HMR) are left for Next.js to handle
  });

  wss.on("connection", (clientWs) => {
    const sessionInfo = sessionMap.get(clientWs);
    if (!sessionInfo) return;

    // Push the current upstream OpenClaw status so the indicator reflects
    // reality even when this connection was opened during an OpenClaw outage.
    // The broadcaster is always defined — see the cold-start stand-in above.
    statusBroadcaster.sendInitialStatus(clientWs);

    const router = openclawClient
      ? new ClientRouter(openclawClient, sessionInfo.userId, sessionInfo.userRole, sessionCache)
      : null;

    clientWs.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (!router) {
          clientWs.send(JSON.stringify({ type: "error", message: "OpenClaw not configured" }));
          return;
        }
        router.handleMessage(clientWs, parsed).catch((err) => {
          console.error("Unhandled router error:", err instanceof Error ? err.message : err);
        });
      } catch {
        // Ignore unparseable messages
      }
    });

    clientWs.on("close", () => {
      if (sessionInfo) wsRateLimiter.releaseConnection(sessionInfo.userId);
      sessionMap.delete(clientWs);
    });

    clientWs.on("error", (err) => {
      console.error("Client WebSocket error:", err.message);
      if (sessionInfo) wsRateLimiter.releaseConnection(sessionInfo.userId);
      sessionMap.delete(clientWs);
    });
  });

  const port = parseInt(process.env.PORT || "7777", 10);

  // Start listening BEFORE bootInits so the Docker Compose healthcheck can
  // reach /api/internal/openclaw-config-ready immediately. The endpoint returns
  // 503 until bootInits calls markOpenClawConfigReady(), at which point the
  // healthcheck passes and the openclaw container is allowed to start.
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`Pinchy ready on http://localhost:${port}`);

  // Graceful shutdown: stop the usage poller interval so Node can exit,
  // then close the HTTP server. Without this, a SIGTERM (e.g. from Docker
  // Compose) leaves the setInterval dangling and the process hangs until
  // the container's kill-grace period expires.
  registerShutdownHandlers([
    () => stopUsagePoller(),
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  ]);

  // Run boot initializations AFTER the server is listening. The healthcheck
  // endpoint returns 503 until markOpenClawConfigReady() is called inside
  // bootInits(), at which point Docker Compose marks the container healthy.
  const { bootInits } = await import("./src/lib/boot-inits");
  const setupWasComplete = await bootInits();

  // Connect to OpenClaw AFTER bootInits so the gateway token and config are
  // ready. On a completed install, bootInits() has already run
  // regenerateOpenClawConfig() which writes the token — waitForGatewayToken
  // returns immediately. On a fresh install (no setup yet), we poll until
  // the setup wizard writes the token (typically within a few seconds).
  // The HTTP server is already running so health/infra checks are not blocked.
  if (OPENCLAW_WS_URL) {
    const gatewayToken = await waitForGatewayToken();
    if (gatewayToken === null) {
      if (setupWasComplete) {
        // Setup is complete but the token is missing — that's a real bug
        // (DB corruption, deleted secret, file-system issue). Exit so Docker
        // restarts the container with a clean attempt rather than silently
        // running with a broken OpenClaw connection.
        console.error(
          "[pinchy] Gateway token missing after setup-complete boot; exiting for restart"
        );
        process.exit(1);
      }
      // Fresh install: setup wizard hasn't run yet. Skip the OpenClaw
      // connection — the wizard will write the token and trigger
      // regenerateOpenClawConfig, after which a Docker restart (or the next
      // boot) will pick up the connection.
      console.warn(
        "[pinchy] Gateway token not available — setup wizard required before OpenClaw connects"
      );
    }
    openclawClient = new OpenClawClient({
      url: OPENCLAW_WS_URL,
      token: gatewayToken ?? "",
      clientId: "gateway-client",
      clientVersion: "0.1.0",
      scopes: ["operator.admin"],
      deviceIdentityPath: process.env.DEVICE_IDENTITY_PATH || "/app/secrets/device-identity.json",
      autoReconnect: true,
      reconnectIntervalMs: 1000,
      maxReconnectAttempts: Infinity,
    });

    setOpenClawClient(openclawClient);

    let hasConnected = false;
    let errorLogged = false;

    openclawClient.connect().catch(() => {
      // Swallow rejection — the error event handler logs once
    });

    openclawClient.on("connected", async () => {
      console.log("Connected to OpenClaw Gateway");
      const firstConnect = !hasConnected;
      hasConnected = true;
      errorLogged = false;
      openClawConnectionState.connected = true;
      if (restartState.isRestarting) {
        restartState.notifyReady();
      }

      if (firstConnect) {
        // Signal to OpenClaw container that device approval succeeded.
        // The auto_approve_devices loop watches for this file and stops,
        // preventing continuous CLI calls that kill Telegram polling.
        try {
          const fs = await import("fs");
          const path = await import("path");
          const signalPath = process.env.OPENCLAW_CONFIG_PATH
            ? path.join(path.dirname(process.env.OPENCLAW_CONFIG_PATH), "pinchy-device-approved")
            : "/openclaw-config/pinchy-device-approved";
          fs.writeFileSync(signalPath, new Date().toISOString());
        } catch {
          // Non-critical — approval loop has a safety timeout
        }

        // Push full config via config.apply on the FIRST connection only. This
        // seeds OC's currentCompareConfig with the complete Pinchy payload so
        // subsequent config.apply calls show only field-level diffs — not a
        // massive diff against the baked-in startup config that triggers
        // gateway/discovery/update/canvasHost restart rules (openclaw#75534,
        // PR #279). Scoped to firstConnect to prevent a cascade: if this push
        // triggers an OC restart (large diff on fresh install), the reconnect
        // (firstConnect=false) won't fire again, terminating the loop.
        regenerateOpenClawConfig().catch((err) => {
          console.warn("[server] on-connected regenerateOpenClawConfig failed:", err);
        });
      }

      // Start global usage poller. Idempotent — a reconnect won't spawn a
      // second poller. The poller handles sessions.list() failures gracefully.
      startUsagePoller(openclawClient!);

      // Seed session cache from OpenClaw's known sessions so that the retry
      // logic in handleHistory works correctly on cold start (e.g. after a
      // Pinchy restart when the cache would otherwise be empty).
      seedSessionCache(openclawClient!, sessionCache).catch(() => {
        // Non-critical — cache fills as users interact
      });
    });

    setupOpenClawDisconnectHandler(openclawClient, sessionMap);
    statusBroadcaster = setupOpenClawStatusBroadcaster(openclawClient, sessionMap);

    openclawClient.on("disconnected", () => {
      openClawConnectionState.connected = false;
      if (hasConnected) {
        console.log("Disconnected from OpenClaw Gateway, reconnecting...");
      }
    });

    openclawClient.on("error", (err) => {
      if (restartState.isRestarting) {
        // Suppress errors during planned restart (config change)
      } else if (hasConnected) {
        // Log errors after a successful connection (unexpected disconnects)
        console.error("OpenClaw client error:", err.message);
      } else if (!errorLogged) {
        // During initial connection, log only once
        console.log("Waiting for OpenClaw Gateway...");
        errorLogged = true;
      }
    });
  } else {
    console.log("OPENCLAW_WS_URL not set — skipping OpenClaw connection");
  }
});
