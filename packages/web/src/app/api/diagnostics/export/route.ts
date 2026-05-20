// Diagnostics bundle export. Authenticated users may export a 5 MB-capped
// JSON bundle for one of their accessible agents' chat sessions. Used by the
// "Report bug" UI in chat (per-message anchor) and in agent settings
// (last-N-turns window).
//
// Pipeline:
//   1. Auth + body validation + agent-access guard (standard route boilerplate).
//   2. Resolve the per-user OpenClaw session via the on-disk sessions.json
//      index, then read the trajectory JSONL.
//   3. Parse → turns → scope-resolve → otel spans.
//   4. Pull audit rows for the session and assemble the bundle.
//   5. Sanitize + enforce 5 MB cap (drops oldest turns until the bundle fits;
//      flags `truncated=true` if the cap still overshoots after dropping all
//      but one span).
//   6. Audit-log the export with byteSize + droppedTurns + truncated so
//      operators can spot whether bundles are getting clipped in the wild.
//
// 5 MB cap and HMAC stripping are defense-in-depth: bundles travel through
// user inboxes and support tickets, so we minimize the secret-shaped surface.

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/api-auth";
import { type AuditLogEntry } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { getAgentWithAccess } from "@/lib/agent-access";
import { parseRequestBody } from "@/lib/api-validation";
import { buildBundle } from "@/lib/diagnostics/bundle-builder";
import { fetchAuditEntriesForSession } from "@/lib/diagnostics/audit-collector";
import {
  readTrajectoryJsonl,
  resolveSessionId,
  TrajectoryFileNotFoundError,
} from "@/lib/diagnostics/jsonl-reader";
import { parseJsonlLines } from "@/lib/diagnostics/jsonl-parser";
import { buildOtelSpans } from "@/lib/diagnostics/otel-builder";
import { sanitizeBundle } from "@/lib/diagnostics/sanitize-bundle";
import { computeScope } from "@/lib/diagnostics/scope-resolver";
import { enforceSizeCap } from "@/lib/diagnostics/size-guard";
import { extractTurns } from "@/lib/diagnostics/turn-extractor";
import { getDiagnosticsVersions } from "@/lib/diagnostics/versions";
import { diagnosticsExportRequestSchema } from "@/lib/schemas/diagnostics";

const DEFAULT_TURN_WINDOW = 10;

export const POST = withAuth(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(diagnosticsExportRequestSchema, request);
  if ("error" in parsed) return parsed.error;
  const { agentId, anchorMessageId, userDescription } = parsed.data;

  const agentOrResp = await getAgentWithAccess(agentId, session.user.id, session.user.role);
  if (agentOrResp instanceof NextResponse) return agentOrResp;
  const agent = agentOrResp;

  const sessionKey = `agent:${agentId}:direct:${session.user.id}`;
  const sessionId = await resolveSessionId(agentId, sessionKey);
  if (!sessionId) {
    return NextResponse.json(
      { error: "No chat session recorded for this user and agent yet" },
      { status: 404 }
    );
  }

  let raw: string;
  try {
    raw = await readTrajectoryJsonl(agentId, sessionId);
  } catch (err) {
    if (err instanceof TrajectoryFileNotFoundError) {
      return NextResponse.json(
        { error: "Trajectory file missing for the recorded session" },
        { status: 404 }
      );
    }
    throw err;
  }

  const events = parseJsonlLines(raw);
  const turns = extractTurns(events);
  const scope = computeScope(turns, anchorMessageId, DEFAULT_TURN_WINDOW);
  const selectedTurns = turns.slice(scope.includedTurnRange[0], scope.includedTurnRange[1] + 1);
  const spans = buildOtelSpans(selectedTurns);
  const auditEntries = await fetchAuditEntriesForSession(agentId, session.user.id);

  const bundle = buildBundle({
    spans,
    versions: getDiagnosticsVersions(),
    scope: {
      agentId,
      sessionKey,
      anchorTurnIndex: scope.anchorTurnIndex,
      sessionTurnCount: turns.length,
      includedTurnRange: scope.includedTurnRange,
    },
    auditEntries,
    userDescription,
  });
  const sanitized = sanitizeBundle(bundle);
  const { bundle: capped, dropped, truncated } = enforceSizeCap(sanitized);

  const auditEntry: AuditLogEntry = {
    actorType: "user",
    actorId: session.user.id,
    eventType: "diagnostics.exported",
    resource: `diagnostics:${agentId}`,
    detail: {
      agent: { id: agent.id, name: agent.name },
      scope: {
        anchorTurnIndex: capped.scope.anchorTurnIndex,
        includedTurnRange: capped.scope.includedTurnRange,
      },
      byteSize: Buffer.byteLength(JSON.stringify(capped), "utf8"),
      droppedTurns: dropped,
      truncated,
    },
    outcome: "success",
  };
  deferAuditLog(auditEntry);

  return NextResponse.json(capped);
});
