import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { eq, sum } from "drizzle-orm";
import type { OpenClawClient } from "openclaw-node";

interface RecordUsageParams {
  openclawClient: OpenClawClient;
  userId: string;
  agentId: string;
  agentName: string;
  sessionKey: string;
}

export async function recordUsage(params: RecordUsageParams): Promise<void> {
  try {
    const { openclawClient, userId, agentId, agentName, sessionKey } = params;

    // Get current cumulative token counts from OpenClaw
    const { sessions } = await openclawClient.sessions.list();
    const session = sessions.find((s: { key: string }) => s.key === sessionKey);

    if (!session) {
      return;
    }

    const currentInput = session.inputTokens ?? 0;
    const currentOutput = session.outputTokens ?? 0;
    const currentCacheRead = session.cacheReadTokens ?? 0;
    const currentCacheWrite = session.cacheWriteTokens ?? 0;

    // Get sum of all previously recorded deltas for this session
    const [prev] = await db
      .select({
        totalInput: sum(usageRecords.inputTokens),
        totalOutput: sum(usageRecords.outputTokens),
        totalCacheRead: sum(usageRecords.cacheReadTokens),
        totalCacheWrite: sum(usageRecords.cacheWriteTokens),
      })
      .from(usageRecords)
      .where(eq(usageRecords.sessionKey, sessionKey));

    const prevInput = Number(prev?.totalInput ?? 0);
    const prevOutput = Number(prev?.totalOutput ?? 0);
    const prevCacheRead = Number(prev?.totalCacheRead ?? 0);
    const prevCacheWrite = Number(prev?.totalCacheWrite ?? 0);

    const deltaInput = currentInput - prevInput;
    const deltaOutput = currentOutput - prevOutput;
    const deltaCacheRead = currentCacheRead - prevCacheRead;
    const deltaCacheWrite = currentCacheWrite - prevCacheWrite;

    // Skip if no meaningful token usage
    if (deltaInput <= 0 && deltaOutput <= 0) {
      return;
    }

    await db.insert(usageRecords).values({
      userId,
      agentId,
      agentName,
      sessionKey,
      model: session.model ?? null,
      inputTokens: deltaInput,
      outputTokens: deltaOutput,
      cacheReadTokens: deltaCacheRead,
      cacheWriteTokens: deltaCacheWrite,
      estimatedCostUsd: null,
    });
  } catch (error) {
    console.error("[usage] Failed to record usage:", error);
  }
}
