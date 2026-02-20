import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer } from "ws";
import { readFileSync } from "fs";
import { OpenClawClient } from "openclaw-node";
import { ClientRouter } from "./src/server/client-router";
import { shouldTriggerGreeting, markGreetingSent } from "./src/lib/greeting";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

const OPENCLAW_WS_URL = process.env.OPENCLAW_WS_URL || "ws://localhost:18789";
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

  const openclawClient = new OpenClawClient({
    url: OPENCLAW_WS_URL,
    token: readGatewayToken(),
    clientId: "gateway-client",
    clientVersion: "0.1.0",
    scopes: ["operator.admin"],
    autoReconnect: true,
    reconnectIntervalMs: 1000,
    maxReconnectAttempts: Infinity,
  });

  const router = new ClientRouter(openclawClient);

  openclawClient.connect().catch((err) => {
    console.error("OpenClaw initial connection failed, will retry:", err.message);
  });

  openclawClient.on("connected", async () => {
    console.log("Connected to OpenClaw Gateway");
    try {
      const trigger = await shouldTriggerGreeting();
      if (trigger) {
        const greetingPrompt =
          "Greet the new admin. Briefly introduce yourself as Smithers and explain what you can help with in Pinchy. Keep it to 2-3 sentences.";
        openclawClient.chatSync(greetingPrompt).catch(() => {});
        await markGreetingSent();
      }
    } catch {
      // Greeting is best-effort
    }
  });

  openclawClient.on("disconnected", () => {
    console.log("Disconnected from OpenClaw Gateway, reconnecting...");
  });

  openclawClient.on("error", (err) => {
    console.error("OpenClaw client error:", err.message);
  });

  // TODO: Authenticate WebSocket connections (validate session token before accepting)
  const wss = new WebSocketServer({ server, path: "/api/ws" });

  wss.on("connection", (clientWs) => {
    clientWs.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        router.handleMessage(clientWs, parsed).catch((err) => {
          console.error("Unhandled router error:", err instanceof Error ? err.message : err);
        });
      } catch {
        // Ignore unparseable messages
      }
    });

    clientWs.on("error", (err) => {
      console.error("Client WebSocket error:", err.message);
    });
  });

  const port = parseInt(process.env.PORT || "7777", 10);
  server.listen(port, () => {
    console.log(`Pinchy ready on http://localhost:${port}`);
  });
});
