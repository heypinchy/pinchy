// audit-exempt: read-only database list, no state changes
import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { parseRequestBody } from "@/lib/api-validation";
import { listDatabasesSchema } from "@/lib/schemas/integrations";

export const POST = withAdmin(async (request) => {
  const parsed = await parseRequestBody(listDatabasesSchema, request);
  if ("error" in parsed) return parsed.error;
  const { url } = parsed.data;

  const urlCheck = await validateExternalUrl(url);
  if (!urlCheck.valid) {
    return NextResponse.json({ error: urlCheck.error }, { status: 400 });
  }

  try {
    // `redirect: "manual"`: the URL above was checked, a redirect target was
    // not. Following one would send this POST — 307/308 keep the body — to
    // wherever the answer points, cloud metadata and loopback included. Odoo's
    // JSON-RPC never needs a redirect, so a 3xx is refused and named.
    const response = await fetch(`${url}/web/database/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "call", params: {} }),
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return NextResponse.json({
        success: false,
        error:
          `Odoo answered with a redirect (HTTP ${response.status}), and Pinchy does not ` +
          "follow redirects. Enter the address Odoo is actually served from.",
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
    } catch {
      return NextResponse.json({
        success: false,
        error: `Could not list databases: Odoo answered ${describe()}, not JSON-RPC.`,
      });
    }

    if (data.error || !Array.isArray(data.result)) {
      return NextResponse.json({ success: false, error: "Could not list databases" });
    }

    return NextResponse.json({ success: true, databases: data.result });
  } catch {
    return NextResponse.json({ success: false, error: "Could not list databases" });
  }
});
