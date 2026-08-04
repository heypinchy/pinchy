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
    const response = await fetch(`${url}/web/database/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "call", params: {} }),
    });
    const data = await response.json();

    if (data.error || !Array.isArray(data.result)) {
      return NextResponse.json({ success: false, error: "Could not list databases" });
    }

    return NextResponse.json({ success: true, databases: data.result });
  } catch {
    return NextResponse.json({ success: false, error: "Could not list databases" });
  }
});
