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
import { isMcpEnabled } from "@/lib/feature-flags";
import { sanitiseExtraHeaders } from "@/lib/integrations/mcp-client";
import type { McpIntegrationData } from "@/lib/integrations/types";

// Request headers we must NOT copy verbatim to the upstream (this is OpenClaw's
// own request to *this* route, not the third-party server):
// - authorization: the gateway bootstrap token, meaningless upstream — replaced
//   with the real third-party token below
// - host: must reflect the upstream, not the Pinchy proxy
// - content-length/connection/transfer-encoding: hop-by-hop, let fetch set them
//
// This is a DIFFERENT list from mcp-client.ts's RESERVED_HEADERS on purpose:
// the two filter different header *sources*. STRIP_REQUEST_HEADERS filters
// what OpenClaw itself sent us before we copy it upstream (transport-layer
// hygiene — host/hop-by-hop headers only make sense in that direction).
// RESERVED_HEADERS filters connection.data.extraHeaders — admin-configured
// config data layered on top — and only needs to cover names that would
// corrupt the JSON-RPC protocol or leak the real token
// (authorization/content-type/accept). Nobody legitimately configures a
// per-server "Connection" or "Host" override via extraHeaders, and even if
// they did, fetch/undici own that layer regardless of what's in the Headers
// object — widening RESERVED_HEADERS to match this set would add filtering
// with nothing real to defend against. Kept as two lists, not merged.
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

async function proxy(request: NextRequest, connectionId: string): Promise<Response> {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Kill switch: with the flag off, the entire MCP surface is absent —
  // consistent with the create/sync routes (T3), which return this same
  // shape before touching the DB. In steady state no mcp.servers config is
  // ever emitted while the flag is off (build.ts, T6), so this route is
  // otherwise unreachable; this is defense in depth for an admin flipping
  // the flag off while MCP connections still exist on disk, and it avoids
  // leaking whether a given connectionId exists while the feature is off.
  if (!isMcpEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);

  if (rows.length === 0) {
    // The plugins surface this body.error into the agent's tool error, so a
    // bare "Connection not found" reaches the user as an opaque "technical
    // problem (error 404)". Make it actionable and provider-generic, mirroring
    // .../internal/integrations/[connectionId]/credentials/route.ts: the
    // connection was removed or replaced (e.g. deleted + re-added, which mints
    // a new id and orphans this reference), and an admin fixes it under
    // Settings → Integrations.
    return NextResponse.json(
      {
        error:
          "This integration is no longer connected — it may have been removed or replaced. An admin can reconnect it under Settings → Integrations.",
      },
      { status: 404 }
    );
  }

  const connection = rows[0];

  if (connection.type !== "mcp") {
    // A different failure mode from the Gone-Contract above: the connectionId
    // is real but not (or no longer) an MCP connection — a config/programming
    // error (e.g. stale mcp.servers config after a connection was retyped),
    // not something a user hits organically. Keep it terse; reusing the
    // actionable wording above would misdirect an admin toward reconnecting
    // something that was never MCP in the first place.
    return NextResponse.json({ error: "Not an MCP connection" }, { status: 404 });
  }
  if (connection.status === "pending") {
    return NextResponse.json({ error: "Connection not active" }, { status: 403 });
  }

  const data = (connection.data ?? {}) as McpIntegrationData;
  const upstreamUrl = data.url;
  if (!upstreamUrl) {
    return NextResponse.json({ error: "Connection has no URL" }, { status: 422 });
  }

  // SSRF guard — re-validate at request time (honors ALLOW_PRIVATE_URLS=1 for
  // self-hosted internal MCP servers). The URL was already validated at create
  // time, but data.url could have changed since (or the guard's rules could
  // have tightened) — never forward to a private/internal host unless the
  // operator opted in right now.
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
  // extraHeaders (e.g. HighLevel's locationId) that OpenClaw doesn't know about.
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  // extraHeaders is applied BEFORE Authorization, and sanitised with the same
  // sanitiseExtraHeaders() the discovery path (mcp-client.ts) uses to strip
  // authorization/content-type/accept — the very set that would otherwise
  // clobber the JSON-RPC protocol or the real token. Setting Authorization
  // last is a second, structural guarantee on top of that sanitisation: even
  // if sanitiseExtraHeaders ever regressed, extraHeaders still could not win
  // the Authorization slot that carries the real bearer token.
  for (const [key, value] of Object.entries(sanitiseExtraHeaders(data.extraHeaders))) {
    headers.set(key, value);
  }
  headers.set("Authorization", `Bearer ${token}`);

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
    // fetch (undici) rejects an aborted request with a DOMException named
    // "AbortError". Check `.name` directly rather than gating on
    // `instanceof Error` first — DOMException does not reliably extend Error
    // across realms/environments (confirmed by this file's own test suite
    // under jsdom, where the global DOMException does NOT satisfy
    // `instanceof Error` even though it does in a plain Node process). A
    // class-identity check here would make the abort → 499 mapping fragile
    // in a way `.name` isn't.
    if (err && typeof err === "object" && "name" in err && err.name === "AbortError") {
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
