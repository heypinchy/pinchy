// audit-exempt: read-only preview, no state changes
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";

const syncPreviewSchema = z.object({
  type: z.literal("odoo"),
  credentials: z.object({
    url: z.string().url(),
    db: z.string().min(1),
    login: z.string().min(1),
    apiKey: z.string().min(1),
    uid: z.number().int().positive(),
  }),
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
  const parsed = syncPreviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { credentials } = parsed.data;

  const urlCheck = validateExternalUrl(credentials.url);
  if (!urlCheck.valid) {
    return NextResponse.json({ error: urlCheck.error }, { status: 400 });
  }

  const result = await fetchOdooSchema(credentials);
  return NextResponse.json(result);
}
