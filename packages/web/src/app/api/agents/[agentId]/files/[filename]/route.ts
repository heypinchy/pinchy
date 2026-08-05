import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api-auth";
import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/workspace";
import { getAgentWithAccess, requireAgentWriteAccess } from "@/lib/agent-access";
import { parseRequestBody } from "@/lib/api-validation";
import { appendAuditLog } from "@/lib/audit";
import { computeLineDiff } from "@/lib/memory-audit-watcher/compute-diff";

const writeFileSchema = z.object({ content: z.string() });

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
  const denied = requireAgentWriteAccess(agentOrError, session.user.id!, session.user.role);
  if (denied) return denied;

  const parsed = await parseRequestBody(writeFileSchema, request);
  if ("error" in parsed) return parsed.error;
  const { content } = parsed.data;

  // Read BEFORE writing, for two reasons that happen to coincide: the previous
  // content is what turns the audit entry into a diff rather than a bare
  // "changed", and readWorkspaceFile runs the same allowed-file assertion the
  // write does — so a disallowed filename still 400s, one step earlier, without
  // ever reaching an audit call. A rejected filename changed nothing on disk
  // and must not mint a row.
  let previous: string;
  try {
    previous = readWorkspaceFile(agentId, filename);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid file";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const { addedLines, removedLines } = computeLineDiff(previous, content);
  const auditDetail = {
    agent: { id: agentOrError.id, name: agentOrError.name },
    file: filename,
    addedLines,
    removedLines,
    byteSize: content.length,
  };

  try {
    writeWorkspaceFile(agentId, filename, content);
  } catch (error: unknown) {
    // Awaited like the success path: a write that failed after passing every
    // access check is the interesting row, not the one worth dropping.
    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "agent.instructions_changed",
      resource: `agent:${agentId}`,
      detail: auditDetail,
      outcome: "failure",
    });
    const message = error instanceof Error ? error.message : "Invalid file";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Awaited rather than deferred: rewriting a file is idempotent, so letting a
  // failed audit write fail the request is safe — the caller retries and lands
  // on the same content (AGENTS.md § audit rules).
  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "agent.instructions_changed",
    resource: `agent:${agentId}`,
    detail: auditDetail,
    outcome: "success",
  });

  return NextResponse.json({ success: true });
});
