// audit-exempt: read-only database list, no state changes
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { validateExternalUrl } from "@/lib/integrations/url-validation";

const listDatabasesSchema = z.object({
  url: z.string().url(),
});

export async function POST(request: NextRequest) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

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
}
