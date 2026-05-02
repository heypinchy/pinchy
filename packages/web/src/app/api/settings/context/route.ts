// audit-exempt: org context editing is a content change, not a security-sensitive admin action
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAdmin } from "@/lib/api-auth";
import { getSetting, setSetting } from "@/lib/settings";
import { syncOrgContextToWorkspaces } from "@/lib/context-sync";
import { parseRequestBody } from "@/lib/api-validation";

const updateOrgContextSchema = z.object({ content: z.string() });

export const GET = withAdmin(async () => {
  const content = await getSetting("org_context");
  return NextResponse.json({ content: content ?? "" });
});

export const PUT = withAdmin(async (request) => {
  const parsed = await parseRequestBody(updateOrgContextSchema, request);
  if ("error" in parsed) return parsed.error;
  const { content } = parsed.data;

  await setSetting("org_context", content);

  await syncOrgContextToWorkspaces();

  return NextResponse.json({ success: true });
});
