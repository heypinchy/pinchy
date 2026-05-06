import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { appendAuditLog } from "@/lib/audit";
import { sanitizeDetail } from "@/lib/audit-sanitize";
import { parseRequestBody } from "@/lib/api-validation";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract the first text content entry from an MCP-style tool result.
 * Returns null if the shape doesn't match.
 */
function extractFirstTextContent(result: Record<string, unknown>): string | null {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (!isObject(first)) return null;
  if (first.type !== "text") return null;
  const text = first.text;
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

function extractAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  return /^agent:([^:]+):/.exec(sessionKey)?.[1];
}

function extractUserIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  return /^agent:[^:]+:direct:(.+)$/.exec(sessionKey)?.[1];
}

// Trim and reject blank strings; turns "" or "   " into undefined so optional
// fields stay optional in a meaningful way.
const trimmedOptional = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });

const toolUsePayloadSchema = z
  .object({
    phase: z.enum(["start", "end"]),
    toolName: z
      .string()
      .transform((v) => v.trim())
      .refine((v) => v.length > 0, "toolName is required"),
    agentId: trimmedOptional,
    runId: trimmedOptional,
    toolCallId: trimmedOptional,
    sessionKey: trimmedOptional,
    sessionId: trimmedOptional,
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: trimmedOptional,
    durationMs: z
      .number()
      .nonnegative()
      .finite()
      .optional()
      .transform((v) => (v === undefined ? undefined : v)),
  })
  .passthrough()
  .transform((v) => ({
    ...v,
    agentId: v.agentId ?? extractAgentIdFromSessionKey(v.sessionKey) ?? "unknown-agent",
  }));

export async function POST(request: NextRequest) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequestBody(toolUsePayloadSchema, request);
  if ("error" in parsed) return parsed.error;
  const payload = parsed.data;

  // Change 1: Only log end phase — start phase carries no result/duration, skip it
  if (payload.phase === "start") {
    return NextResponse.json({ success: true });
  }

  // Audit entries should answer: who, what, when, on what, outcome.
  // No full result payloads (contain business data), no OpenClaw-internal IDs.
  const detail: Record<string, unknown> = {
    toolName: payload.toolName,
    success: !payload.error,
  };

  if (payload.params !== undefined) detail.params = payload.params;
  if (payload.error) detail.error = payload.error;
  if (payload.durationMs !== undefined) detail.durationMs = payload.durationMs;

  // Change 3: Actor becomes the user extracted from sessionKey when possible
  const userId = extractUserIdFromSessionKey(payload.sessionKey);
  const actorType = userId ? "user" : "agent";
  const actorId = userId ?? payload.agentId;

  const sanitizedDetail = sanitizeDetail(detail);

  // Derive outcome from two signals:
  //   1. payload.error (transport/dispatch-level failure from OpenClaw's hook)
  //   2. result.isError (semantic failure — MCP convention for tools that
  //      returned normally at the protocol level but reported an error
  //      inside the result, e.g. ENOENT on pinchy_read)
  // Transport errors take precedence because they're the more fundamental
  // failure. For semantic errors, we try to lift the first text content
  // entry as the error message.
  const resultObj = isObject(payload.result) ? payload.result : null;
  const resultIsError = resultObj?.isError === true;
  const semanticErrorMessage =
    resultIsError && resultObj
      ? (extractFirstTextContent(resultObj) ?? "Tool returned an error")
      : null;

  const outcome: "success" | "failure" = payload.error || resultIsError ? "failure" : "success";
  const error = payload.error
    ? { message: payload.error }
    : semanticErrorMessage
      ? { message: semanticErrorMessage }
      : null;

  try {
    await appendAuditLog({
      actorType,
      actorId,
      // Change 2: eventType becomes tool.<toolName>
      eventType: `tool.${payload.toolName}`,
      resource: `agent:${payload.agentId}`,
      detail: sanitizedDetail,
      outcome,
      error,
    });
  } catch {
    return NextResponse.json({ error: "Audit logging failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
