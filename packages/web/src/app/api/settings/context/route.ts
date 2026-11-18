// audit-exempt: org context editing is a content change, not a security-sensitive admin action
import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getSetting, setSetting } from "@/lib/settings";
import { syncOrgContextToWorkspaces } from "@/lib/context-sync";
import { parseRequestBody } from "@/lib/api-validation";
import { contextContentSchema } from "@/lib/schemas/context";

export const GET = withAdmin(async () => {
  const content = await getSetting("org_context");
  return NextResponse.json({ content: content ?? "" });
});

export const PUT = withAdmin(async (request) => {
  const parsed = await parseRequestBody(contextContentSchema, request);
  if ("error" in parsed) return parsed.error;
  const { content } = parsed.data;

  await setSetting("org_context", content);

  await syncOrgContextToWorkspaces();

  return NextResponse.json({ success: true });
});
