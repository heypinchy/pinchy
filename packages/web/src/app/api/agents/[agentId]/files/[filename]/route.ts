// audit-exempt: knowledge base file edits are per-agent content changes, not admin actions
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/workspace";
import { getAgentWithAccess, assertAgentWriteAccess } from "@/lib/agent-access";

type Params = { params: Promise<{ agentId: string; filename: string }> };

export const GET = withAuth<Params>(async (_req, { params }, session) => {
  const { agentId, filename } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  try {
    const content = readWorkspaceFile(agentId, filename);
    return NextResponse.json({ content });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid file";
    return NextResponse.json({ error: message }, { status: 400 });
  }
});

export const PUT = withAuth<Params>(async (request, { params }, session) => {
  const { agentId, filename } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  // Only admins or personal agent owners can modify agent files
  try {
    assertAgentWriteAccess(agentOrError, session.user.id!, session.user.role);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { content } = await request.json();

  if (typeof content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }

  try {
    writeWorkspaceFile(agentId, filename, content);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid file";
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
