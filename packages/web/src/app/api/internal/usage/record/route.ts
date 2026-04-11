// audit-exempt: internal telemetry sink for OpenClaw plugins reporting LLM token usage, not a user-facing action
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";

interface UsagePayload {
  agentId: string;
  agentName: string;
  userId: string;
  sessionKey: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePayload(value: unknown): UsagePayload | null {
  if (!isObject(value)) return null;

  const agentId = value.agentId;
  const agentName = value.agentName;
  const userId = value.userId;
  const sessionKey = value.sessionKey;
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  const model = value.model;

  if (
    typeof agentId !== "string" ||
    !agentId ||
    typeof agentName !== "string" ||
    !agentName ||
    typeof userId !== "string" ||
    !userId ||
    typeof sessionKey !== "string" ||
    !sessionKey ||
    typeof inputTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    typeof outputTokens !== "number" ||
    !Number.isFinite(outputTokens)
  ) {
    return null;
  }

  return {
    agentId,
    agentName,
    userId,
    sessionKey,
    model: typeof model === "string" && model ? model : undefined,
    inputTokens,
    outputTokens,
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
