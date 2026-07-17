// audit-exempt: internal endpoint called by OpenClaw plugin, not a user-facing action
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
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
