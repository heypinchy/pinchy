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
import { listUserAgentChats } from "@/lib/chats/list-user-agent-chats";
import { collectAgentConfig } from "@/lib/diagnostics/agent-config-collector";
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
import { directSessionKey } from "@/lib/session-key";
import { diagnosticsExportRequestSchema } from "@/lib/schemas/diagnostics";

const DEFAULT_TURN_WINDOW = 10;
const AUDIT_RANGE_PADDING_MS = 5_000;
// Backstop on audit rows in a bundle. Normal exports are already time-scoped to
// the selected turns; this bounds the degrade/empty-session paths where the
// range is unbounded, since the size guard only trims spans (not audit rows).
const MAX_AUDIT_ROWS = 1_000;

/**
 * Build the [from, to] window for audit-row scoping from the turns the bundle
 * selected. Returns `undefined` (= no range filter, fetch everything) when the
 * turns don't carry usable timestamps — over-collecting beats under-collecting
 * in diagnostics, and the size-cap will still trim.
 */
function computeAuditRange(
  turns: import("@/lib/diagnostics/turn-extractor").Turn[]
): { from: Date; to: Date } | undefined {
  const stamps: number[] = [];
  for (const t of turns) {
    if (t.userMessage?.timestamp !== undefined) stamps.push(t.userMessage.timestamp);
    if (t.assistantResponse?.timestamp !== undefined) stamps.push(t.assistantResponse.timestamp);
  }
  if (stamps.length === 0) return undefined;
  const min = Math.min(...stamps);
  const max = Math.max(...stamps);
  return {
    from: new Date(min - AUDIT_RANGE_PADDING_MS),
    to: new Date(max + AUDIT_RANGE_PADDING_MS),
  };
}

export const POST = withAuth(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(diagnosticsExportRequestSchema, request);
  if ("error" in parsed) return parsed.error;
  const { agentId, anchorMessageId, userDescription, sessionId: selectedSessionId } = parsed.data;

  const agentOrResp = await getAgentWithAccess(agentId, session.user.id, session.user.role);
  if (agentOrResp instanceof NextResponse) return agentOrResp;
  const agent = agentOrResp;

  // Resolve which chat to export. Two paths:
  //   - selector (#639): the client picked a specific chat by its opaque
  //     sessionId. Re-authorize it by enumerating the user's OWN chats and
  //     matching — this reaches named per-chat sessions (#508) and read-only
  //     Telegram peers, which `directSessionKey` structurally can't. An
  //     unmatched id is an unknown/inaccessible chat → 404.
  //   - default (no selector): today's behaviour — the user's default chat.
  let sessionKey: string;
  let sessionId: string;
  let exportedChatId: string | null;
  if (selectedSessionId) {
    let chats: Awaited<ReturnType<typeof listUserAgentChats>>["chats"];
    try {
      ({ chats } = await listUserAgentChats(agentId, session.user.id));
    } catch {
      return NextResponse.json({ error: "Failed to load chats" }, { status: 502 });
    }
    const match = chats.find((c) => c.sessionId === selectedSessionId);
    if (!match) {
      return NextResponse.json({ error: "No such chat for this user and agent" }, { status: 404 });
    }
    sessionKey = match.key;
    sessionId = match.sessionId;
    exportedChatId = match.chatId;
  } else {
    sessionKey = directSessionKey(agentId, session.user.id);
    const resolved = await resolveSessionId(agentId, sessionKey);
    if (!resolved) {
      return NextResponse.json(
        { error: "No chat session recorded for this user and agent yet" },
        { status: 404 }
      );
    }
    sessionId = resolved;
    exportedChatId = null;
  }

  // Read the trajectory. When the chat is authorized but its trajectory file is
  // gone (#639), don't 404 — degrade to an audit-only bundle so support still
  // gets the audit trail, flagged with `trajectoryMissing`.
  let raw: string | null = null;
  let trajectoryMissing = false;
  try {
    raw = await readTrajectoryJsonl(agentId, sessionId);
  } catch (err) {
    if (err instanceof TrajectoryFileNotFoundError) {
      trajectoryMissing = true;
    } else {
      throw err;
    }
  }

  // One pipeline for both cases: on a missing trajectory `raw` is null, which
  // parses to zero events → zero turns, and every downstream step
  // (computeScope, buildOtelSpans, computeAuditRange) already handles the empty
  // case — computeScope returns the canonical empty slice `[0, -1]`, spans is
  // `[]`, and the audit range is unbounded. No separate degrade branch needed.
  const events = parseJsonlLines(raw ?? "");
  const turns = extractTurns(events);
  const scope = computeScope(turns, anchorMessageId, DEFAULT_TURN_WINDOW);
  const selectedTurns = turns.slice(scope.includedTurnRange[0], scope.includedTurnRange[1] + 1);
  const spans = buildOtelSpans(selectedTurns);
  // Scope audit rows to the same time window as the selected turns so a busy
  // agent doesn't drown the bundle in unrelated history. Pad by 5s on each
  // side to catch tool audit rows written just before/after the model.completed
  // event (chat.* and tool.* are written from independent code paths). With no
  // turns (empty/missing trajectory) the range is undefined, so MAX_AUDIT_ROWS
  // caps the otherwise-unbounded fetch.
  //
  // Known limitation: audit rows are scoped to `actorId = this web user`. For a
  // selected Telegram chat the trajectory still exports, but its audit rows are
  // stamped with the Telegram principal, so the bundle's audit section is empty
  // for Telegram exports. Documented in reporting-issues.mdx; a cross-principal
  // fetch is deferred to the admin/cross-user export work.
  const auditRange = computeAuditRange(selectedTurns);
  const auditEntries = await fetchAuditEntriesForSession(
    agentId,
    session.user.id,
    auditRange,
    MAX_AUDIT_ROWS
  );

  // Snapshot the agent's configuration at export time (model/provider, allowed
  // tools, instruction hashes) so a support reader can tell config drift apart
  // from model choice. Never embeds the raw prompt — only its hash (#642).
  const agentConfig = await collectAgentConfig(agent);

  const bundle = buildBundle({
    spans,
    versions: getDiagnosticsVersions(),
    agentConfig,
    scope: {
      agentId,
      sessionKey,
      anchorTurnIndex: scope.anchorTurnIndex,
      sessionTurnCount: turns.length,
      includedTurnRange: scope.includedTurnRange,
      trajectoryMissing,
    },
    auditEntries,
    userDescription,
  });
  // Pipeline-order invariant: sanitize BEFORE enforceSizeCap.
  // `sanitizeDetail` only substitutes (`[REDACTED]` is shorter than every
  // secret-shaped string it matches), so it never grows the bundle. Running
  // it first means enforceSizeCap's byte measurement reflects exactly what
  // ships to the user. Swapping the order would mean we could overshoot the
  // cap by however much sanitization shrinks the payload.
  const sanitized = sanitizeBundle(bundle);
  const { bundle: capped, dropped, truncated } = enforceSizeCap(sanitized);

  const auditEntry: AuditLogEntry = {
    actorType: "user",
    actorId: session.user.id,
    eventType: "diagnostics.exported",
    resource: `diagnostics:${agentId}`,
    detail: {
      agent: { id: agent.id, name: agent.name },
      // Which chat was exported (#639): null = the default/legacy chat or a
      // Telegram peer (both carry chatId: null).
      chatId: exportedChatId,
      scope: {
        anchorTurnIndex: capped.scope.anchorTurnIndex,
        includedTurnRange: capped.scope.includedTurnRange,
      },
      byteSize: Buffer.byteLength(JSON.stringify(capped), "utf8"),
      droppedTurns: dropped,
      truncated,
      // Source from the local truth, not the round-tripped bundle, so a future
      // change to how the bundle represents this can't silently skew the audit.
      trajectoryMissing,
    },
    outcome: "success",
  };
  deferAuditLog(auditEntry);

  return NextResponse.json(capped);
});
