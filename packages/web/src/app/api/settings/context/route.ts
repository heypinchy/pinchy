import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";
import { syncOrgContextToWorkspaces } from "@/lib/context-sync";
import { restartState } from "@/server/restart-state";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const content = await getSetting("org_context");
  return NextResponse.json({ content: content ?? "" });
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { content } = await request.json();

  if (typeof content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }

  await setSetting("org_context", content);

  await syncOrgContextToWorkspaces();
  restartState.notifyRestart();

  return NextResponse.json({ success: true });
}
