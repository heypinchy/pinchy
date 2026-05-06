/**
 * MCP client — lists tools from a remote MCP server over HTTP or SSE transport.
 *
 * Typed errors:
 *   McpAuthError   — server returned 401
 *   McpServerError — server returned 5xx (includes status code + body for audit log)
 *   McpSchemaError — response was valid JSON but a tool was missing `name`
 *
 * SSRF protection: validateExternalUrl() is called before any network request.
 * Timeout: defaults to 10 seconds, overrideable for tests.
 *
 * Implementation note: We use direct JSON-RPC fetch rather than the MCP SDK's
 * Client class for HTTP transport because the SDK's StreamableHTTPClientTransport
 * creates its own internal AbortController and does not propagate the signal from
 * requestInit to its fetch calls. Direct fetch gives us full abort signal control.
 * For SSE transport we use the SDK transport as SSE requires event-source handling.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpTool } from "./types";
import { validateExternalUrl } from "./url-validation";

// ---------------------------------------------------------------------------
// Typed error subclasses
// ---------------------------------------------------------------------------

export class McpAuthError extends Error {
  constructor(message = "MCP server returned 401 Unauthorized") {
    super(message);
    this.name = "McpAuthError";
  }
}

export class McpServerError extends Error {
  readonly statusCode: number;
  readonly body: string;

  constructor(statusCode: number, body: string) {
    super(`MCP server returned ${statusCode}: ${body}`);
    this.name = "McpServerError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

export class McpSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSchemaError";
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ListMcpToolsOptions {
  url: string;
  transport: "http" | "sse";
  token: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Lists tools exposed by a remote MCP server.
 *
 * @param opts  Connection options (url, transport type, bearer token)
 * @param signal  Optional external AbortSignal (e.g. from a request context)
 * @param timeoutMs  Override the default 10-second timeout (for tests)
 */
export async function listMcpTools(
  opts: ListMcpToolsOptions,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<McpTool[]> {
  // SSRF protection — must happen before any network activity
  const validation = validateExternalUrl(opts.url);
  if (!validation.valid) {
    throw new Error(`Invalid MCP server URL: ${validation.error}`);
  }

  // Build an AbortController for the timeout
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Merge caller signal with our timeout signal
  const combinedSignal = signal
    ? mergeSignals(signal, timeoutController.signal)
    : timeoutController.signal;

  try {
    if (opts.transport === "http") {
      return await listToolsViaHttp(opts, combinedSignal);
    } else {
      return await listToolsViaSse(opts, combinedSignal);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// HTTP transport — direct JSON-RPC (gives full AbortSignal control)
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function listToolsViaHttp(
  opts: ListMcpToolsOptions,
  signal: AbortSignal
): Promise<McpTool[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${opts.token}`,
  };

  // Step 1: initialize
  const initResponse = await fetchJsonRpc(
    opts.url,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pinchy-mcp-client", version: "1.0.0" },
      },
    },
    headers,
    signal
  );

  // Extract session ID if provided (Streamable HTTP spec)
  const sessionId = initResponse.headers.get("mcp-session-id");

  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  await parseJsonRpcBody(initResponse);

  // Step 2: send initialized notification (fire and forget per spec)
  const notifyHeaders = { ...headers };
  fetch(opts.url, {
    method: "POST",
    headers: notifyHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal,
  }).catch(() => {
    // Notification response is optional — ignore errors
  });

  // Step 3: list tools
  const toolsResponse = await fetchJsonRpc(
    opts.url,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    headers,
    signal
  );

  const toolsBody = await parseJsonRpcBody(toolsResponse);
  return validateAndMapTools(toolsBody);
}

async function fetchJsonRpc(
  url: string,
  payload: object,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"))) {
      throw err;
    }
    throw err;
  }

  if (response.status === 401) {
    throw new McpAuthError();
  }

  if (response.status >= 500 && response.status < 600) {
    const body = await response.text().catch(() => `HTTP ${response.status}`);
    throw new McpServerError(response.status, body);
  }

  return response;
}

async function parseJsonRpcBody(response: Response): Promise<unknown> {
  // The Streamable HTTP transport may return 202 Accepted for notifications
  if (response.status === 202) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";

  // Handle SSE responses from Streamable HTTP (GET-based SSE streams)
  if (contentType.includes("text/event-stream")) {
    return parseFirstSseEvent(response);
  }

  const text = await response.text();
  if (!text.trim()) return null;

  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new McpSchemaError(`MCP server returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (parsed.error) {
    throw new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`);
  }

  return parsed.result;
}

async function parseFirstSseEvent(response: Response): Promise<unknown> {
  const text = await response.text();
  // Parse SSE format: lines starting with "data: "
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      try {
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.error) {
          throw new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`);
        }
        return parsed.result;
      } catch (e) {
        if (
          e instanceof McpAuthError ||
          e instanceof McpServerError ||
          e instanceof McpSchemaError
        ) {
          throw e;
        }
        throw new McpSchemaError(`MCP server returned invalid SSE data: ${data.slice(0, 200)}`);
      }
    }
  }
  throw new McpSchemaError("MCP server SSE response contained no data event");
}

// ---------------------------------------------------------------------------
// SSE transport — uses SDK (SSE requires event-source handling)
// ---------------------------------------------------------------------------

async function listToolsViaSse(opts: ListMcpToolsOptions, signal: AbortSignal): Promise<McpTool[]> {
  const serverUrl = new URL(opts.url);
  const requestInit: RequestInit = {
    headers: {
      Authorization: `Bearer ${opts.token}`,
    },
  };

  const client = new Client({ name: "pinchy-mcp-client", version: "1.0.0" }, { capabilities: {} });

  const transport = new SSEClientTransport(serverUrl, { requestInit });

  // Wire up abort: if signal fires, close the transport
  const abortHandler = () => {
    transport.close().catch(() => {});
  };
  signal.addEventListener("abort", abortHandler, { once: true });

  try {
    await client.connect(transport);

    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const result = await client.listTools();
    return validateAndMapTools(result);
  } catch (err) {
    throw translateSdkError(err);
  } finally {
    signal.removeEventListener("abort", abortHandler);
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface RawTool {
  name?: unknown;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function validateAndMapTools(result: unknown): McpTool[] {
  if (!result || typeof result !== "object") {
    throw new McpSchemaError("MCP tools/list result is not an object");
  }

  const asResult = result as { tools?: unknown };
  if (!Array.isArray(asResult.tools)) {
    throw new McpSchemaError("MCP tools/list result missing 'tools' array");
  }

  return asResult.tools.map((tool: RawTool, index: number) => {
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      throw new McpSchemaError(
        `MCP server returned a tool at index ${index} without a valid 'name' field: ${JSON.stringify(tool)}`
      );
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
    };
  });
}

function translateSdkError(err: unknown): Error {
  if (
    err instanceof McpAuthError ||
    err instanceof McpServerError ||
    err instanceof McpSchemaError
  ) {
    return err;
  }

  if (err instanceof Error) {
    const asHttpErr = err as Error & { code?: unknown };
    if (typeof asHttpErr.code === "number") {
      const statusCode = asHttpErr.code;
      if (statusCode === 401) return new McpAuthError();
      if (statusCode >= 500 && statusCode < 600) {
        return new McpServerError(statusCode, err.message);
      }
    }

    if (err.name === "$ZodError" || err.constructor?.name === "$ZodError") {
      return new McpSchemaError(`MCP server returned invalid tool schema: ${err.message}`);
    }

    return err;
  }

  return new Error(String(err));
}

/**
 * Merges two AbortSignals — aborts when either fires.
 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
  } else {
    a.addEventListener("abort", abort, { once: true });
    b.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
