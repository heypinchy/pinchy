// audit-exempt: read-only database list, no state changes
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAdmin } from "@/lib/api-auth";
import { validateExternalUrl } from "@/lib/integrations/url-validation";

const listDatabasesSchema = z.object({
  url: z.string().url(),
});

export const POST = withAdmin(async (request) => {
  const body = await request.json();
  const parsed = listDatabasesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { url } = parsed.data;

  const urlCheck = validateExternalUrl(url);
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
