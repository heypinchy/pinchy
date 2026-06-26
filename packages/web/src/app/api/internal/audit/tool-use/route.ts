import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { appendAuditLog, safeProviderError } from "@/lib/audit";
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

// Resolve detail.error from the three possible sources in fixed precedence:
//   payload.error (transport)  >  resultDetails.error (plugin-supplied string)
//   >  semanticErrorMessage (lifted from result.content)
// Returns undefined when no string source is available, so the caller can
// either omit the field (non-override path) or delete it after Object.assign
// (override path).
function resolveDetailError(args: {
  payloadError: string | undefined;
  resultDetailsError: unknown;
  semanticErrorMessage: string | null;
}): string | undefined {
  if (args.payloadError) return args.payloadError;
  if (typeof args.resultDetailsError === "string") return args.resultDetailsError;
  if (args.semanticErrorMessage) return args.semanticErrorMessage;
  return undefined;
}

function extractAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  return /^agent:([^:]+):/.exec(sessionKey)?.[1];
}

function extractUserIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  // Capture only the userId segment. Direct session keys gained a trailing
  // chatId segment with the chats feature (agent:<agentId>:direct:<userId>:<chatId>);
  // a greedy `(.+)$` would swallow `<userId>:<chatId>` and mis-attribute the
  // audit row. The userId itself never contains a colon.
  return /^agent:[^:]+:direct:([^:]+)/.exec(sessionKey)?.[1];
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

  // Derive outcome from three signals up-front so detail.success / detail.error
  // stay consistent with the audit row's outcome / error columns:
  //   1. payload.error (transport/dispatch-level failure from OpenClaw's hook)
  //   2. result.isError (semantic failure — MCP convention for tools that
  //      returned normally at the protocol level but reported an error
  //      inside the result, e.g. ENOENT on pinchy_read, EEXIST on pinchy_write)
  //   3. result.details.error (plugin-curated semantic error message) —
  //      defence against the upstream gap noted in issue #404: OpenClaw's
  //      tool-use audit hook was observed on staging v0.5.4 stripping the
  //      MCP `isError` flag before forwarding the result to /api/internal/
  //      audit/tool-use, so this is sometimes the only failure signal we
  //      receive. Only non-empty strings count to avoid false-positive
  //      failures from plugins that emit `details.error: ""`.
  // Transport errors take precedence because they're the more fundamental
  // failure. For semantic errors, we lift the first text content entry as
  // the error message.
  const resultObj = isObject(payload.result) ? payload.result : null;
  const resultIsError = resultObj?.isError === true;

  // Plugin can override the audit detail by returning result.details.
  // Used by tools whose params contain sensitive data (e.g. pinchy_write.content).
  // When details is set, raw params are not logged.
  const resultDetails =
    resultObj && isObject(resultObj.details)
      ? (resultObj.details as Record<string, unknown>)
      : null;
  const detailsErrorString =
    typeof resultDetails?.error === "string" && resultDetails.error.length > 0
      ? resultDetails.error
      : null;

  // semantic = "the tool returned successfully at protocol level but
  // signalled a failure inside its result". That covers both `isError: true`
  // (the MCP convention) and the OC-hook-strips-isError fallback path where
  // only `details.error` arrives. In both cases the most user-friendly
  // message lives in content[0].text; fall back to details.error and finally
  // a generic string so the audit row's `error.message` is never empty when
  // outcome=failure.
  const hasSemanticFailure = resultIsError || Boolean(detailsErrorString);
  const semanticErrorMessage =
    hasSemanticFailure && resultObj
      ? (extractFirstTextContent(resultObj) ?? detailsErrorString ?? "Tool returned an error")
      : null;
  const outcome: "success" | "failure" =
    payload.error || hasSemanticFailure ? "failure" : "success";

  // Tool error strings are arbitrary upstream text and can echo an email or a
  // secret. The audit row is HMAC-signed and append-only, so scrub before the
  // value lands in detail.error or the error column (GDPR Art. 17 + secret
  // leakage). safeProviderError applies scrubEmails + a byte cap; sanitizeDetail
  // (applied later to detail) only catches secret patterns, not emails.
  const rawDetailError = resolveDetailError({
    payloadError: payload.error,
    resultDetailsError: resultDetails?.error,
    semanticErrorMessage,
  });
  const detailError = rawDetailError !== undefined ? safeProviderError(rawDetailError) : undefined;

  // Audit entries should answer: who, what, when, on what, outcome.
  // No full result payloads (contain business data), no OpenClaw-internal IDs.
  const detail: Record<string, unknown> = {
    toolName: payload.toolName,
    success: outcome === "success",
  };

  if (payload.params !== undefined) detail.params = payload.params;
  if (detailError !== undefined) detail.error = detailError;
  if (payload.durationMs !== undefined) detail.durationMs = payload.durationMs;

  if (resultDetails) {
    // Param-suppression is the PII contract for CURATED details — fields
    // beyond `error` (e.g. pinchy_write replacing sensitive content with
    // path/contentHash). An error-only `details: { error }`, which every
    // failed tool now emits so OpenClaw's isError-stripping (#404) can't mask
    // the failure, must NOT suppress params: forensics need to know what the
    // failed call attempted (the 2026-06-25 false-success incident hinged on
    // those params being lost).
    const curatesNonErrorFields = Object.keys(resultDetails).some((k) => k !== "error");
    if (curatesNonErrorFields) delete detail.params;
    Object.assign(detail, resultDetails);
    // Plugins must not override these system fields. Re-apply after merge.
    detail.toolName = payload.toolName;
    detail.success = outcome === "success";
    if (detailError !== undefined) detail.error = detailError;
    else delete detail.error;
  }

  // Change 3: Actor becomes the user extracted from sessionKey when possible
  const userId = extractUserIdFromSessionKey(payload.sessionKey);
  const actorType = userId ? "user" : "agent";
  const actorId = userId ?? payload.agentId;

  const sanitizedDetail = sanitizeDetail(detail);

  const error = payload.error
    ? { message: safeProviderError(payload.error) }
    : semanticErrorMessage
      ? { message: safeProviderError(semanticErrorMessage) }
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
