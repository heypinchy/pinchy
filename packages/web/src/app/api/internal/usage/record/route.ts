// audit-exempt: internal telemetry sink for OpenClaw plugins reporting LLM token usage, not a user-facing action
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { tryAcquireUsageRecordSlot } from "@/lib/usage-record-rate-limiter";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { parseRequestBody } from "@/lib/api-validation";

const usagePayloadSchema = z
  .object({
    agentId: z.string().min(1),
    agentName: z.string().min(1),
    userId: z.string().min(1),
    sessionKey: z.string().min(1),
    model: z
      .string()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),
    inputTokens: z.number().nonnegative().finite(),
    outputTokens: z.number().nonnegative().finite(),
  })
  .passthrough();

export async function POST(request: NextRequest) {
  // Defense-in-depth rate limit — runs BEFORE token validation so a brute
  // forcer cannot guess the gateway token at line rate. See
  // `src/lib/usage-record-rate-limiter.ts` for the window configuration.
  if (!tryAcquireUsageRecordSlot()) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequestBody(usagePayloadSchema, request);
  if ("error" in parsed) return parsed.error;
  const payload = parsed.data;

  await db.insert(usageRecords).values({
    userId: payload.userId,
    agentId: payload.agentId,
    agentName: payload.agentName,
    sessionKey: payload.sessionKey,
    model: payload.model ?? null,
    inputTokens: payload.inputTokens,
    outputTokens: payload.outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: null,
  });

  return NextResponse.json({ success: true });
}
