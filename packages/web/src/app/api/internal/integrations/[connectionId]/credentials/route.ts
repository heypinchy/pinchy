// audit-exempt: internal endpoint called by OpenClaw plugin, not a user-facing
// action. A successful fetch is deliberately not audited — plugins re-fetch on
// every cache miss, so a row per success would be pure volume. A DENIED fetch
// is audited (#987): that one is a security event, and it is rare.
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { authorizeAgentConnection } from "@/lib/integrations/authorize-agent-connection";
import { deferAuditLog } from "@/lib/audit-deferred";
import {
  resolveConnectionCredentials,
  ConnectionNotFoundError,
  ConnectionNotActiveError,
  CredentialsDecryptError,
  OAuthSettingsMissingError,
} from "@/lib/integrations/resolve-credentials";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { connectionId } = await params;

  // Who is asking. The gateway token proves only that the caller runs inside
  // the OpenClaw container — it is one shared secret handed to every plugin,
  // so on its own it authorized any plugin to fetch any connection's
  // decrypted credentials (#987). Every caller now names its agent, and the
  // grant is checked against `agent_connection_permissions` (or, for the
  // instance-wide web-search connection, the agent's tool list).
  //
  // Missing id is a hard 400 rather than a lenient fallback: a fallback is a
  // one-parameter route back to the behaviour this closes.
  const agentId = request.nextUrl.searchParams.get("agentId");
  if (!agentId) {
    return NextResponse.json(
      { error: "agentId is required — the calling plugin must identify its agent" },
      { status: 400 }
    );
  }

  const access = await authorizeAgentConnection(agentId, connectionId);
  // `connection-unknown` falls through on purpose: the resolver below answers
  // it with the actionable "no longer connected" 404 an admin can act on.
  if (!access.allowed && access.reason !== "connection-unknown") {
    deferAuditLog({
      actorType: "agent",
      actorId: agentId,
      eventType: "integration.credentials_denied",
      resource: `integration:${connectionId}`,
      outcome: "failure",
      detail: {
        agent: { id: agentId, name: access.agent?.name ?? agentId },
        connection: { id: connectionId },
        reason: access.reason,
      },
    });
    return NextResponse.json(
      { error: "This agent is not granted access to this integration" },
      { status: 403 }
    );
  }

  // The credential-resolution logic (decrypt + OAuth auto-refresh + re-encrypt)
  // is shared with the Inbox Agent's mailbox port via resolveConnectionCredentials;
  // here we map its typed failures back to the HTTP contract the plugins expect.
  try {
    const resolved = await resolveConnectionCredentials(connectionId);
    return NextResponse.json(resolved);
  } catch (err) {
    if (err instanceof ConnectionNotFoundError) {
      // The plugins surface this body.error into the agent's tool error, so a bare
      // "Connection not found" reaches the user as an opaque "technical problem
      // (error 404)". Make it actionable and provider-generic: the connection was
      // removed or replaced (e.g. deleted + re-added, which mints a new id and
      // orphans this reference), and an admin fixes it under Settings → Integrations.
      return NextResponse.json(
        {
          error:
            "This integration is no longer connected — it may have been removed or replaced. An admin can reconnect it under Settings → Integrations.",
        },
        { status: 404 }
      );
    }
    if (err instanceof ConnectionNotActiveError) {
      return NextResponse.json({ error: "Connection not active" }, { status: 403 });
    }
    if (err instanceof CredentialsDecryptError) {
      return NextResponse.json({ error: "Failed to decrypt credentials" }, { status: 500 });
    }
    if (err instanceof OAuthSettingsMissingError) {
      // The access token is expired and there is no way to refresh it — fail
      // loudly instead of returning a 200 with stale/expired tokens that the
      // plugin would cache for another 5 minutes and fail on.
      return NextResponse.json(
        {
          error: `${err.provider} OAuth settings missing — reconnect the mailbox or restore the OAuth app`,
        },
        { status: 503 }
      );
    }
    throw err;
  }
}
