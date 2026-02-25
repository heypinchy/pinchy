import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/workspace";
import { getAgentWithAccess } from "@/lib/agent-access";
import { restartState } from "@/server/restart-state";

type Params = { params: Promise<{ agentId: string; filename: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentId, filename } = await params;

  const agentOrError = await getAgentWithAccess(
    agentId,
    session.user.id!,
    session.user.role || "user"
  );
  if (agentOrError instanceof NextResponse) return agentOrError;

  try {
    const content = readWorkspaceFile(agentId, filename);
    return NextResponse.json({ content });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid file";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentId, filename } = await params;

  const agentOrError = await getAgentWithAccess(
    agentId,
    session.user.id!,
    session.user.role || "user"
  );
  if (agentOrError instanceof NextResponse) return agentOrError;

  const { content } = await request.json();

  if (typeof content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }

  try {
    writeWorkspaceFile(agentId, filename, content);
    restartState.notifyRestart();
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid file";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
