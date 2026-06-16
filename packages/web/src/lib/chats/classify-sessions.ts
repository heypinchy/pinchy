/**
 * Pure, I/O-free classifier that filters an agent's `sessions.list` output
 * down to ONLY the chats that belong to the requesting Pinchy user.
 *
 * This is the authorization boundary for the Chats feature: `sessions.list`
 * returns every user's direct sessions for an agent, so a bug here would leak
 * one user's conversations (web or Telegram) to another. It therefore fails
 * closed — anything we cannot positively attribute to the requesting user is
 * excluded.
 *
 * Classification is driven entirely by parsing the session KEY. We never trust
 * a `kind` field: OpenClaw reports `kind: "direct"` even for cron keys.
 */

export type RawSession = {
  key: string;
  sessionId: string;
  label?: string;
  lastInteractionAt?: number;
  updatedAt?: number;
};

export type ClassifiedChat = {
  sessionId: string;
  key: string;
  origin: "web" | "telegram";
  writable: boolean;
  chatId: string | null;
  lastInteractionAt: number;
};

export function classifyUserSessions(
  sessions: RawSession[],
  userId: string,
  linkedTelegramPeerIds: ReadonlySet<string>
): ClassifiedChat[] {
  const ownPrincipal = userId.toLowerCase();
  const result: ClassifiedChat[] = [];

  for (const session of sessions) {
    const parts = session.key.split(":");

    // Only agent direct keys: agent:<agentId>:direct:<principal>[:<chatId>].
    // Drops :cron:, :subagent:, agent:<id>:main, and anything malformed.
    if (parts[0] !== "agent" || parts[2] !== "direct") continue;

    const principal = parts[3];
    const extra = parts.slice(4);
    const lastInteractionAt = session.lastInteractionAt ?? session.updatedAt ?? 0;

    if (principal === ownPrincipal) {
      // The user's own web chat. A 4-segment key is a legacy chat with no
      // chatId; a 5-segment key carries the chatId. More than one extra
      // segment is malformed — fail closed.
      if (extra.length > 1) continue;
      result.push({
        sessionId: session.sessionId,
        key: session.key,
        origin: "web",
        writable: true,
        chatId: extra[0] ?? null,
        lastInteractionAt,
      });
      continue;
    }

    if (linkedTelegramPeerIds.has(principal)) {
      // A Telegram peer linked to this user. Read-only from the web UI, and
      // the key must not carry extra segments — fail closed if it does.
      if (extra.length > 0) continue;
      result.push({
        sessionId: session.sessionId,
        key: session.key,
        origin: "telegram",
        writable: false,
        chatId: null,
        lastInteractionAt,
      });
      continue;
    }

    // Another user's chat, or an unlinked peer. Exclude.
  }

  return result;
}
