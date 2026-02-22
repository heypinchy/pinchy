import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { readFileSync } from "fs";
import { OpenClawClient } from "openclaw-node";
import { ClientRouter } from "./src/server/client-router";
import { validateWsSession } from "./src/server/ws-auth";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

const OPENCLAW_WS_URL = process.env.OPENCLAW_WS_URL;
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";

function readGatewayToken(): string {
  try {
    const config = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    return config.gateway?.auth?.token ?? "";
  } catch {
    return "";
  }
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url!, true));
  });

  let openclawClient: OpenClawClient | null = null;

  if (OPENCLAW_WS_URL) {
    openclawClient = new OpenClawClient({
      url: OPENCLAW_WS_URL,
      token: readGatewayToken(),
      clientId: "gateway-client",
      clientVersion: "0.1.0",
      scopes: ["operator.admin"],
      deviceIdentityPath:
        process.env.DEVICE_IDENTITY_PATH || "/openclaw-config/device-identity.json",
      autoReconnect: true,
      reconnectIntervalMs: 1000,
      maxReconnectAttempts: Infinity,
    });

    openclawClient.connect().catch((err) => {
      console.error("OpenClaw initial connection failed, will retry:", err.message);
    });

    openclawClient.on("connected", () => {
      console.log("Connected to OpenClaw Gateway");
    });

    openclawClient.on("disconnected", () => {
      console.log("Disconnected from OpenClaw Gateway, reconnecting...");
    });

    openclawClient.on("error", (err) => {
      console.error("OpenClaw client error:", err.message);
    });
  } else {
    console.log("OPENCLAW_WS_URL not set — skipping OpenClaw connection");
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });
  const sessionMap = new Map<WebSocket, { userId: string; userRole: string }>();

  server.on("upgrade", async (request, socket, head) => {
    const { pathname } = parse(request.url!, true);
    if (pathname === "/api/ws") {
      const session = await validateWsSession(request.headers.cookie);
      if (!session) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        sessionMap.set(ws, {
          userId: (session.sub as string) || (session.id as string),
          userRole: (session.role as string) || "user",
        });
        wss.emit("connection", ws, request);
      });
    }
    // Other upgrade requests (e.g. Next.js HMR) are left for Next.js to handle
  });

  wss.on("connection", (clientWs) => {
    const sessionInfo = sessionMap.get(clientWs);
    if (!sessionInfo) return;

    const router = openclawClient
      ? new ClientRouter(openclawClient, sessionInfo.userId, sessionInfo.userRole)
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
      sessionMap.delete(clientWs);
    });

    clientWs.on("error", (err) => {
      console.error("Client WebSocket error:", err.message);
      sessionMap.delete(clientWs);
    });
  });

  const port = parseInt(process.env.PORT || "7777", 10);
  server.listen(port, () => {
    console.log(`Pinchy ready on http://localhost:${port}`);
  });
});
