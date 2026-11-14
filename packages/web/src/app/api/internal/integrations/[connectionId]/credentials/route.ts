// audit-exempt: internal endpoint called by OpenClaw plugin, not a user-facing
// action. A successful fetch is deliberately not audited — plugins re-fetch on
// every cache miss, so a row per success would be pure volume. A DENIED fetch
// is audited (#987): that one is a security event, and it is rare. So is a
// fetch refused because the stored destination fails the SSRF guard.
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { authorizeAgentConnection } from "@/lib/integrations/authorize-agent-connection";
import {
  checkStoredDestination,
  StoredDestinationRefusedError,
} from "@/lib/integrations/stored-destination";
import { deferAuditLog } from "@/lib/audit-deferred";
import {
  resolveConnectionCredentials,
  ConnectionNotFoundError,
  ConnectionNotActiveError,
  CredentialsDecryptError,
  OAuthSettingsMissingError,
} from "@/lib/integrations/resolve-credentials";

// Agent ids are `crypto.randomUUID()` (db/schema.ts), but the route accepts any
// conservative id rather than only UUIDs so an unusual legacy id is not locked
// out. The point is the bound: `agentId` comes from the query string and is
// written into audit rows as `actorId` (a text column that `truncateDetail`
// does not cover) and into `detail`, so an unbounded value mints oversized rows.
const MAX_AGENT_ID_LENGTH = 128;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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

  // Malformed input, not a denial: no audit row, or the oversized value would
  // land in the trail anyway.
  if (agentId.length > MAX_AGENT_ID_LENGTH || !AGENT_ID_PATTERN.test(agentId)) {
    return NextResponse.json(
      {
        error: "agentId is malformed — expected at most 128 characters of letters, digits, - or _",
      },
      { status: 400 }
    );
  }

  const access = await authorizeAgentConnection(agentId, connectionId);
  // `connection-unknown` falls through on purpose: the resolver below answers
  // it with the actionable "no longer connected" 404 an admin can act on.
  if (!access.allowed && access.reason !== "connection-unknown") {
    // Deferred, not awaited — and deliberately against the letter of
    // `deferAuditLog`'s own docstring, which reserves it for side effects that
    // cannot be rolled back. A denial has no side effect at all; the reason is
    // the other direction. Awaiting would let a failing audit write turn a
    // correct 403 into a 500, and a 500 is the one answer worse than the
    // denial: the plugin retries it, and an admin reads it as Pinchy being
    // broken rather than as a permission it has to grant. The write is not
    // silent when it fails — `recordAuditFailure` bumps the process-wide
    // counter and emits an `audit_log_write_failed` line.
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

    // The destination was validated when the connection was saved, and the
    // plugin connects to whatever it is handed here — so re-check it under the
    // rules as they are now (an upgrade may have tightened them, an operator
    // may have removed ALLOW_PRIVATE_URLS). Every plugin fetch passes through
    // this route, which makes it the choke point. See stored-destination.ts.
    const destination = await checkStoredDestination(resolved.type, resolved.credentials);
    if (!destination.allowed && destination.transient) {
      // The resolver failed, not the destination: nothing was refused, so no
      // denial row (it would read as a security event) and no 403. A 503 is
      // final for the plugin's call but caches nothing, so the next tool call
      // asks again.
      return NextResponse.json({ error: destination.message }, { status: 503 });
    }
    if (!destination.allowed) {
      // Deferred for the same reason as the grant denial above: an audit write
      // that fails must not turn a correct refusal into a 500 the plugin
      // retries. The refused address stays out of the row — a mail host can be
      // a person's own domain — and `field` is enough to find it.
      deferAuditLog({
        actorType: "agent",
        actorId: agentId,
        eventType: "integration.credentials_denied",
        resource: `integration:${connectionId}`,
        outcome: "failure",
        detail: {
          agent: { id: agentId, name: access.agent?.name ?? agentId },
          connection: { id: connectionId },
          reason: "destination-blocked",
          field: destination.field,
        },
      });
      // 403, never 401: the plugins read a 401 from this route as Pinchy
      // briefly unable to read the gateway token and retry it for several
      // seconds, which would only delay this final refusal. The body reaches
      // the agent's tool error, so it carries the guard's message, which
      // names the fix.
      return NextResponse.json(
        {
          error:
            new StoredDestinationRefusedError(destination.field, destination.message).message +
            " An admin can change the address under Settings → Integrations.",
        },
        { status: 403 }
      );
    }

    // The addresses the guard just classified, per field. The plugin connects
    // to these rather than resolving the stored name again: a resolver that
    // answered this check with a public address could answer the plugin's own
    // lookup with 127.0.0.1 (DNS rebinding). A field it could not check is
    // absent, and the plugin refuses to connect to it.
    const checkedAddresses = Object.fromEntries(
      Object.entries(destination.checked ?? {}).map(([field, target]) => [
        field,
        target.map(({ address }) => address),
      ])
    );
    // A mail host whose lookup failed travels here, not as an error status:
    // pinchy-email reads a 503 as "OAuth settings missing" and would flag a
    // healthy connection. The plugin refuses to connect to that host and says
    // whether to fix the name or just try again.
    const lookupFailures = destination.lookupFailures ?? {};
    return NextResponse.json({ ...resolved, checkedAddresses, lookupFailures });
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
