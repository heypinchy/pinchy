// audit-exempt: org context editing is a content change, not a security-sensitive admin action
import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getSetting, setSetting } from "@/lib/settings";
import { syncOrgContextToWorkspaces } from "@/lib/context-sync";

export const GET = withAdmin(async () => {
  const content = await getSetting("org_context");
  return NextResponse.json({ content: content ?? "" });
});

export const PUT = withAdmin(async (request) => {
  const { content } = await request.json();

  if (typeof content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }

  await setSetting("org_context", content);

  await syncOrgContextToWorkspaces();

  return NextResponse.json({ success: true });
});
