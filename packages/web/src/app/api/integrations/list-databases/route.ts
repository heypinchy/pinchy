// audit-exempt: read-only database list, no state changes
import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { resolveExternalUrlTarget } from "@/lib/integrations/url-validation";
import { pinnedFetch } from "@/lib/pinned-connection";
import { parseRequestBody } from "@/lib/api-validation";
import { listDatabasesSchema } from "@/lib/schemas/integrations";
import {
  isOdooTimeout,
  odooRedirectRefusedMessage,
  odooTimeoutMessage,
} from "@/lib/integrations/odoo-error";
import { ODOO_REQUEST_TIMEOUT_MS } from "@/lib/integrations/odoo-pin";

export const POST = withAdmin(async (request) => {
  const parsed = await parseRequestBody(listDatabasesSchema, request);
  if ("error" in parsed) return parsed.error;
  const { url } = parsed.data;

  // Resolve once and send the request to that answer: validating the URL and
  // then fetching it by name resolved twice, and the second lookup could
  // answer an address the first one would have refused (DNS rebinding).
  const urlCheck = await resolveExternalUrlTarget(url);
  if (!urlCheck.valid) {
    return NextResponse.json({ error: urlCheck.error }, { status: urlCheck.transient ? 503 : 400 });
  }

  try {
    // `redirect: "manual"`: the URL above was checked, a redirect target was
    // not. Following one would send this POST — 307/308 keep the body — to
    // wherever the answer points, cloud metadata and loopback included. Odoo's
    // JSON-RPC never needs a redirect, so a 3xx is refused and named.
    const response = await pinnedFetch(
      `${url}/web/database/list`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "call", params: {} }),
        redirect: "manual",
        // The bound every Odoo request from the web app keeps; it covers the
        // body read below too. Without it an Odoo that took the connection
        // and went silent held the dialog for undici's 300 s.
        signal: AbortSignal.timeout(ODOO_REQUEST_TIMEOUT_MS),
      },
      urlCheck.target
    );

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return NextResponse.json({
        success: false,
        error: odooRedirectRefusedMessage(response.status),
      });
    }

    // Status and content type only, never the body: an unexpected answer may
    // come from a host that is not Odoo, and its body is not ours to show.
    const describe = () =>
      `HTTP ${response.status}, ${response.headers.get("content-type") ?? "no content type"}`;

    if (!response.ok) {
      await response.body?.cancel();
      return NextResponse.json({
        success: false,
        error: `Could not list databases: Odoo answered ${describe()}.`,
      });
    }

    let data: { error?: unknown; result?: unknown };
    try {
      data = await response.json();
    } catch (err) {
      if (isOdooTimeout(err)) throw err; // A body that stopped arriving, not a wrong one.
      return NextResponse.json({
        success: false,
        error: `Could not list databases: Odoo answered ${describe()}, not JSON-RPC.`,
      });
    }

    if (data.error || !Array.isArray(data.result)) {
      return NextResponse.json({ success: false, error: "Could not list databases" });
    }

    return NextResponse.json({ success: true, databases: data.result });
  } catch (err) {
    if (isOdooTimeout(err)) {
      return NextResponse.json({ success: false, error: odooTimeoutMessage() });
    }
    return NextResponse.json({ success: false, error: "Could not list databases" });
  }
});
