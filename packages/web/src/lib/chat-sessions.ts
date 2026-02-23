import { db } from "@/db";
import { chatSessions } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";

interface ChatSession {
  id: string;
  sessionKey: string;
  userId: string;
  agentId: string;
  runtimeActivated: boolean;
}

/**
 * Get the most recent chat session for a user+agent pair, or create a new one.
 * The session key is used internally for OpenClaw — it never leaves the server.
 */
export async function getOrCreateSession(userId: string, agentId: string): Promise<ChatSession> {
  const existing = await db.query.chatSessions.findFirst({
    where: and(eq(chatSessions.userId, userId), eq(chatSessions.agentId, agentId)),
    orderBy: desc(chatSessions.createdAt),
  });

  if (existing) return existing;

  try {
    const [session] = await db
      .insert(chatSessions)
      .values({
        sessionKey: `user:${userId}:agent:${agentId}`,
        userId,
        agentId,
      })
      .returning();

    return session;
  } catch (err) {
    // Handle unique constraint violation (e.g. session_key already exists for another user)
    if (err instanceof Error && "code" in err && (err as Error & { code: string }).code === "23505") {
      const fallback = await db.query.chatSessions.findFirst({
        where: eq(chatSessions.agentId, agentId),
        orderBy: desc(chatSessions.createdAt),
      });
      if (fallback) return fallback;
    }
    throw err;
  }
}

/**
 * Mark a session as activated in the runtime. Called after the first successful
 * chat() call, so subsequent history requests know it's safe to query OpenClaw.
 */
export async function markSessionActivated(sessionId: string): Promise<void> {
  await db
    .update(chatSessions)
    .set({ runtimeActivated: true })
    .where(eq(chatSessions.id, sessionId));
}
