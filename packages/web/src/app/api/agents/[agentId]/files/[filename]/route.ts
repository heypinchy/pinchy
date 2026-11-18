import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/workspace";
import { getAgentWithAccess, requireAgentWriteAccess } from "@/lib/agent-access";
import { parseRequestBody } from "@/lib/api-validation";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { computeLineDiff } from "@/lib/memory-audit-watcher/compute-diff";

import { writeAgentFileSchema } from "@/lib/schemas/agents";

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

  const parsed = await parseRequestBody(writeAgentFileSchema, request);
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

  // A save that changes nothing is not an edit, and must not read like one.
  // The settings page PUTs SOUL.md whenever the Personality tab is dirty —
  // which an avatar or preset change makes it (agent-settings-page-content.tsx),
  // without touching a word of the file. Auditing the write rather than the
  // change would file "someone edited this agent's Personality" against
  // someone who picked a new avatar, and nothing in the row would let an
  // auditor tell that apart from a real edit. The write itself still runs: it
  // is what reclaims a root-owned file (#1095), and skipping it would trade an
  // audit fix for a production regression.
  const contentChanged = previous !== content;

  const { addedLines, removedLines } = computeLineDiff(previous, content);
  const auditEntry = (outcome: "success" | "failure"): AuditLogEntry => ({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "agent.instructions_changed",
    resource: `agent:${agentId}`,
    detail: {
      agent: { id: agentOrError.id, name: agentOrError.name },
      file: filename,
      addedLines,
      removedLines,
      // Bytes, not UTF-16 code units — `content.length` would disagree with
      // agent.memory_changed on every non-ASCII file, and the point of sharing
      // this detail shape is that one query reads both families.
      byteSize: Buffer.byteLength(content, "utf8"),
    },
    outcome,
  });

  try {
    writeWorkspaceFile(agentId, filename, content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid file";
    if (contentChanged) {
      // Awaited like the success row, but its own failure is caught rather
      // than propagated. The write has already failed and the 400 below names
      // the cause (#1095 surfaces as EACCES); letting a second failure escape
      // would replace that with an unhandled rejection — a 500 explaining
      // nothing, over a row the caller can do nothing about.
      // recordAuditFailure is AGENTS.md's pattern for exactly this: an audit
      // write that must not sink the response.
      const entry = auditEntry("failure");
      try {
        await appendAuditLog(entry);
      } catch (auditError: unknown) {
        recordAuditFailure(auditError, entry);
      }
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (contentChanged) {
    // Awaited rather than deferred: rewriting a file is idempotent, so letting
    // a failed audit write fail the request is safe — the caller retries and
    // lands on the same content (AGENTS.md § audit rules).
    await appendAuditLog(auditEntry("success"));
  }

  return NextResponse.json({ success: true });
});
