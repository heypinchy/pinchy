// audit-exempt: transparent MCP transport proxy called by OpenClaw (gateway-token
// authed), not a user-facing action. Tool-level audit is emitted by OpenClaw's
// before_tool_call/after_tool_call hooks via the pinchy-audit plugin — auditing
// here would double-count and lack tool semantics.
//
// Credential-injecting MCP reverse proxy. OpenClaw's native `mcp.servers.<id>`
// points at this route (authed with the gateway bootstrap token) instead of the
// third-party MCP server directly. We look up the connection, decrypt its bearer
// token IN MEMORY, inject `Authorization: Bearer <token>`, and transparently
// stream the MCP request/response to/from the real upstream. The third-party
// token therefore never lands in openclaw.json — it lives only in Pinchy's
// encrypted DB + this process's memory. OpenClaw's bundled MCP SDK speaks the
// protocol; this route is a byte-level passthrough that only swaps auth.
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "@/lib/encryption";
import { validateExternalUrl } from "@/lib/integrations/url-validation";

// Request headers we must NOT copy verbatim to the upstream:
// - authorization: replaced with the real third-party token
// - host: must reflect the upstream, not the Pinchy proxy
// - content-length/connection/transfer-encoding: hop-by-hop, let fetch set them
const STRIP_REQUEST_HEADERS = new Set([
  "authorization",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);

// Response headers we must NOT copy back (hop-by-hop / would corrupt the stream).
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "transfer-encoding",
]);

interface McpConnectionData {
  url?: string;
  extraHeaders?: Record<string, string>;
}

async function proxy(request: NextRequest, connectionId: string): Promise<Response> {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const connection = rows[0];

  if (connection.type !== "mcp") {
    return NextResponse.json({ error: "Not an MCP connection" }, { status: 404 });
  }
  if (connection.status === "pending") {
    return NextResponse.json({ error: "Connection not active" }, { status: 403 });
  }

  const data = (connection.data ?? {}) as McpConnectionData;
  const upstreamUrl = data.url;
  if (!upstreamUrl) {
    return NextResponse.json({ error: "Connection has no URL" }, { status: 422 });
  }

  // SSRF guard — re-validate at request time (honors ALLOW_PRIVATE_URLS=1 for
  // self-hosted internal MCP servers). Never forward to a private/internal host
  // unless the operator opted in.
  const validation = validateExternalUrl(upstreamUrl);
  if (!validation.valid) {
    return NextResponse.json(
      { error: `Upstream URL rejected: ${validation.error}` },
      { status: 502 }
    );
  }

  let token: string;
  try {
    token = (JSON.parse(decrypt(connection.credentials)) as { token?: string }).token ?? "";
  } catch {
    // Never echo the credential payload — only a generic failure.
    return NextResponse.json({ error: "Failed to decrypt credentials" }, { status: 500 });
  }

  // Build upstream headers: forward OpenClaw's request headers (Mcp-Session-Id,
  // Accept, Content-Type, Last-Event-Id, …) but replace Authorization with the
  // real token and drop host/hop-by-hop. Inject the connection's non-secret
  // extraHeaders (e.g. HighLevel locationId) that OpenClaw doesn't know about.
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  headers.set("Authorization", `Bearer ${token}`);
  for (const [key, value] of Object.entries(data.extraHeaders ?? {})) {
    headers.set(key, value);
  }

  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      signal: request.signal,
      // Do not auto-follow redirects: a redirect Location could point at an
      // internal host (SSRF) or bypass the proxy entirely. Known MCP servers
      // don't redirect the JSON-RPC endpoint; reject if one does.
      redirect: "manual",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Client (OpenClaw) closed the connection — nothing to return.
      return new NextResponse(null, { status: 499 });
    }
    return NextResponse.json({ error: "Upstream MCP request failed" }, { status: 502 });
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return NextResponse.json(
      { error: "Upstream MCP server attempted a redirect, which is not supported" },
      { status: 502 }
    );
  }

  // Stream the upstream response back verbatim — no buffering, so long-lived SSE
  // streams flow through with backpressure intact. Forward upstream headers
  // (Mcp-Session-Id, Content-Type, …) minus hop-by-hop.
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    responseHeaders.set(key, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await params;
  return proxy(request, connectionId);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await params;
  return proxy(request, connectionId);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await params;
  return proxy(request, connectionId);
}
