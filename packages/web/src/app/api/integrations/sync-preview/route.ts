// audit-exempt: read-only preview, no state changes
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAdmin } from "@/lib/api-auth";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { parseRequestBody } from "@/lib/api-validation";

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

export const POST = withAdmin(async (request) => {
  const parsed = await parseRequestBody(syncPreviewSchema, request);
  if ("error" in parsed) return parsed.error;
  const { credentials } = parsed.data;

  const urlCheck = validateExternalUrl(credentials.url);
  if (!urlCheck.valid) {
    return NextResponse.json({ error: urlCheck.error }, { status: 400 });
  }

  const result = await fetchOdooSchema(credentials);
  return NextResponse.json(result);
});
