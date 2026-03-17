import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { appendAuditLog } from "@/lib/audit";
import { sanitizeDetail } from "@/lib/audit-sanitize";

interface ToolAuditPayload {
  phase: "start" | "end";
  toolName: string;
  agentId: string;
  runId?: string;
  toolCallId?: string;
  sessionKey?: string;
  sessionId?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1];
}

function extractUserIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const match = /^agent:[^:]+:user-(.+)$/.exec(sessionKey);
  return match?.[1];
}

function parsePayload(value: unknown): ToolAuditPayload | null {
  if (!isObject(value)) return null;

  const phase = value.phase;
  if (phase !== "start" && phase !== "end") return null;

  const toolName = asNonEmptyString(value.toolName);
  const sessionKey = asNonEmptyString(value.sessionKey);
  const agentId =
    asNonEmptyString(value.agentId) ?? extractAgentIdFromSessionKey(sessionKey) ?? "unknown-agent";
  if (!toolName) return null;

  const runId = asNonEmptyString(value.runId);
  const toolCallId = asNonEmptyString(value.toolCallId);
  const sessionId = asNonEmptyString(value.sessionId);
  const error = asNonEmptyString(value.error);

  const durationRaw = value.durationMs;
  const durationMs =
    typeof durationRaw === "number" && Number.isFinite(durationRaw) && durationRaw >= 0
      ? durationRaw
      : undefined;

  return {
    phase,
    toolName,
    agentId,
    runId,
    toolCallId,
    sessionKey,
    sessionId,
    params: value.params,
    result: value.result,
    error,
    durationMs,
  };
}

export async function POST(request: NextRequest) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = parsePayload(await request.json());
  if (!payload) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Change 1: Only log end phase — start phase carries no result/duration, skip it
  if (payload.phase === "start") {
    return NextResponse.json({ success: true });
  }

  const detail: Record<string, unknown> = {
    toolName: payload.toolName,
    phase: payload.phase,
    source: "openclaw_hook",
  };

  if (payload.runId) detail.runId = payload.runId;
  if (payload.toolCallId) detail.toolCallId = payload.toolCallId;
  if (payload.sessionKey) detail.sessionKey = payload.sessionKey;
  if (payload.sessionId) detail.sessionId = payload.sessionId;
  if (payload.params !== undefined) detail.params = payload.params;

  if (payload.result !== undefined) detail.result = payload.result;
  if (payload.error) detail.error = payload.error;
  if (payload.durationMs !== undefined) detail.durationMs = payload.durationMs;

  // Change 3: Actor becomes the user extracted from sessionKey when possible
  const userId = extractUserIdFromSessionKey(payload.sessionKey);
  const actorType = userId ? "user" : "agent";
  const actorId = userId ?? payload.agentId;

  const sanitizedDetail = sanitizeDetail(detail);

  await appendAuditLog({
    actorType,
    actorId,
    // Change 2: eventType becomes tool.<toolName>
    eventType: `tool.${payload.toolName}`,
    resource: `agent:${payload.agentId}`,
    detail: sanitizedDetail,
  });

  return NextResponse.json({ success: true });
}
