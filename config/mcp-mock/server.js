// Mock MCP server for E2E testing.
// Implements the MCP JSON-RPC protocol (HTTP transport) and a /control API
// for test orchestration.
//
// MCP endpoints (all at POST /):
//   initialize           — returns server info and capabilities
//   notifications/initialized — returns 202
//   tools/list           — returns enabled tools
//   tools/call           — executes a (mock) tool call
//
// Control endpoints:
//   GET  /control/health       — liveness probe
//   POST /control/reset        — restore all three tools to enabled state
//   POST /control/seed         — idempotent alias for reset (adds/enables all tools)
//   POST /control/toggle-tool  — body: { tool, enabled } — enable or disable a tool
//   GET  /control/calls        — return list of recorded tool calls
//   POST /control/clear-calls  — reset the call log
//
// CommonJS, zero dependencies — runs on plain Node.js.

const http = require("http");

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const ALL_TOOLS = [
  {
    name: "create_issue",
    description: "Create a new issue in a repository",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body" },
        repo: { type: "string", description: "Repository name" },
      },
      required: ["title", "repo"],
    },
  },
  {
    name: "list_repos",
    description: "List available repositories",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Organization name" },
      },
      required: [],
    },
  },
  {
    name: "legacy_search",
    description: "Legacy full-text search across repositories",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
];

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------

function getDefaultToolState() {
  const state = {};
  for (const tool of ALL_TOOLS) {
    state[tool.name] = true; // all enabled
  }
  return state;
}

let toolEnabled = getDefaultToolState();
let callLog = []; // { tool, args, calledAt }

function getEnabledTools() {
  return ALL_TOOLS.filter((t) => toolEnabled[t.name]);
}

// ---------------------------------------------------------------------------
// Tool call handlers
// ---------------------------------------------------------------------------

function handleToolCall(toolName, args) {
  // Record the call regardless of whether the tool is enabled.
  // (The allow-list is enforced at the agent level — the mock always responds
  // if the call reaches it. The E2E test validates that ungranted calls never
  // reach the mock.)
  callLog.push({ tool: toolName, args, calledAt: new Date().toISOString() });

  switch (toolName) {
    case "create_issue":
      return {
        content: [{ type: "text", text: "Issue #42 created" }],
      };
    case "list_repos":
      return {
        content: [{ type: "text", text: "Repos: pinchy, openclaw" }],
      };
    case "legacy_search":
      return {
        content: [{ type: "text", text: "Search results: ..." }],
      };
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC handler
// ---------------------------------------------------------------------------

function handleMcpRequest(body) {
  const method = body.method;
  const id = body.id ?? null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "mcp-mock", version: "1.0.0" },
      },
    };
  }

  if (method === "notifications/initialized") {
    // Notification — caller handles the 202 separately
    return null;
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: getEnabledTools() },
    };
  }

  if (method === "tools/call") {
    const toolName = body.params?.name;
    const toolArgs = body.params?.arguments ?? {};
    const result = handleToolCall(toolName, toolArgs);
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Main HTTP server (MCP + control surface on one port)
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "9005", 10);

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const method = req.method;

  // ── Control API ──────────────────────────────────────────────────────────

  if (method === "GET" && url === "/control/health") {
    sendJson(res, 200, {
      status: "ok",
      tools: Object.keys(toolEnabled).filter((k) => toolEnabled[k]),
    });
    return;
  }

  if (method === "POST" && url === "/control/reset") {
    toolEnabled = getDefaultToolState();
    callLog = [];
    sendJson(res, 200, { status: "reset" });
    return;
  }

  if (method === "POST" && url === "/control/seed") {
    // Seed = ensure all tools are enabled (idempotent alias for reset).
    // Unlike reset, it does not clear the call log so tests can seed between
    // individual scenarios without losing prior call data.
    toolEnabled = getDefaultToolState();
    sendJson(res, 200, { status: "seeded" });
    return;
  }

  if (method === "POST" && url === "/control/toggle-tool") {
    const body = await readBody(req);
    if (
      !body ||
      typeof body.tool !== "string" ||
      typeof body.enabled !== "boolean"
    ) {
      sendJson(res, 400, { error: "Need { tool: string, enabled: boolean }" });
      return;
    }
    if (!(body.tool in toolEnabled)) {
      sendJson(res, 404, { error: `Unknown tool: ${body.tool}` });
      return;
    }
    toolEnabled[body.tool] = body.enabled;
    sendJson(res, 200, {
      status: "ok",
      tool: body.tool,
      enabled: body.enabled,
    });
    return;
  }

  if (method === "GET" && url === "/control/calls") {
    sendJson(res, 200, callLog);
    return;
  }

  if (method === "POST" && url === "/control/clear-calls") {
    callLog = [];
    sendJson(res, 200, { status: "cleared" });
    return;
  }

  // ── MCP JSON-RPC ─────────────────────────────────────────────────────────

  if (method === "POST" && url === "/") {
    const body = await readBody(req);
    if (!body) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    // Notifications get 202 with no body
    if (body.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }

    const response = handleMcpRequest(body);
    if (response === null) {
      res.writeHead(202);
      res.end();
      return;
    }

    sendJson(res, 200, response);
    return;
  }

  // ── Fallback ─────────────────────────────────────────────────────────────

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Mock MCP server listening on port ${PORT}`);
  console.log(`  MCP endpoint:  POST http://localhost:${PORT}/`);
  console.log(`  Health check:  GET  http://localhost:${PORT}/control/health`);
});
