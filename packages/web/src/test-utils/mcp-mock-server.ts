/**
 * Reusable mock MCP server for unit and integration tests.
 *
 * Creates a minimal HTTP server that responds to MCP JSON-RPC requests.
 * Supports four control modes:
 *   - "normal": returns a valid tool list
 *   - "auth-error": returns 401
 *   - "server-error": returns 500 with an error body
 *   - "malformed": returns tools missing the `name` field
 *   - "hang": never responds (used to test timeout)
 *
 * Usage:
 *   const { server, port, close } = await createMcpMockServer("normal");
 *   // ... run tests against http://localhost:<port>/mcp ...
 *   await close();
 */

import http from "node:http";

export type MockServerMode = "normal" | "auth-error" | "server-error" | "malformed" | "hang";

export interface McpMockServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

const NORMAL_TOOLS_RESPONSE = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [
      {
        name: "get_weather",
        description: "Get the current weather for a location",
        inputSchema: {
          type: "object",
          properties: {
            location: { type: "string", description: "City name" },
          },
          required: ["location"],
        },
      },
      {
        name: "search_web",
        description: "Search the web",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ],
  },
};

const MALFORMED_TOOLS_RESPONSE = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [
      {
        // missing `name` — intentionally malformed for schema validation tests
        description: "A tool without a name",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  },
};

// Also handle the initialize request that the MCP SDK sends before listTools
const INITIALIZE_RESPONSE = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: "mcp-mock-server",
      version: "1.0.0",
    },
  },
};

export async function createMcpMockServer(mode: MockServerMode): Promise<McpMockServer> {
  // Track open connections so we can destroy them on close
  const openSockets = new Set<import("node:net").Socket>();

  const server = http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only handle POST requests for MCP JSON-RPC
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Handle auth-error mode
    if (mode === "auth-error") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Handle server-error mode
    if (mode === "server-error") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
      return;
    }

    // Handle hang mode — never respond
    if (mode === "hang") {
      // Don't respond — connection will hang until timeout
      return;
    }

    // Parse the request body to determine what type of request this is
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { method?: string; id?: number | string };
        const method = parsed.method;
        const id = parsed.id ?? 1;

        if (method === "initialize") {
          const response = { ...INITIALIZE_RESPONSE, id };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
          return;
        }

        if (method === "notifications/initialized") {
          // Notification — no response needed
          res.writeHead(202);
          res.end();
          return;
        }

        if (method === "tools/list") {
          if (mode === "malformed") {
            const response = { ...MALFORMED_TOOLS_RESPONSE, id };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
            return;
          }

          const response = { ...NORMAL_TOOLS_RESPONSE, id };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
          return;
        }

        // Unknown method
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown method: ${method}` }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  });

  // Track open connections for forced teardown
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get server address");
  }

  const port = address.port;

  const close = () =>
    new Promise<void>((resolve, reject) => {
      // Destroy all open sockets first so hanging connections don't block close()
      for (const socket of openSockets) {
        socket.destroy();
      }
      openSockets.clear();
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

  return { server, port, close };
}
