// audit-exempt: read-only capability lookup
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { db } from "@/db";
import { models } from "@/db/schema";

export const GET = withAuth(async () => {
  const rows = await db.select().from(models);
  const out: Record<
    string,
    {
      vision: boolean;
      documents: boolean;
      audio: boolean;
      video: boolean;
      longContext: boolean;
      tools: boolean;
    }
  > = {};
  for (const r of rows) {
    out[`${r.provider}/${r.modelId}`] = {
      vision: r.vision ?? false,
      documents: r.documents ?? false,
      audio: r.audio ?? false,
      video: r.video ?? false,
      longContext: r.longContext ?? false,
      tools: r.tools ?? false,
    };
  }
  // The capability map changes only at boot (catalog seed) or when the admin
  // adds/removes a provider. A 60-second private cache avoids a DB round-trip
  // on every cold tab while staying fresh enough for operational changes.
  return NextResponse.json(out, {
    headers: { "Cache-Control": "private, max-age=60" },
  });
});
