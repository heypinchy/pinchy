type MessageRole = "user" | "assistant";
type MessageStatus = "sent" | "sending" | "failed" | undefined;

interface Message {
  id: string;
  role: MessageRole;
  status?: MessageStatus;
}

interface OrphanContext {
  isRunning: boolean;
  isHistoryLoaded: boolean;
}

/**
 * Returns true when the last user message was sent but the agent has no
 * response and is not currently running — indicating an orphaned message
 * that needs a retry (Case B retry bubble).
 */
export function isOrphaned(
  messages: Message[],
  { isRunning, isHistoryLoaded }: OrphanContext
): boolean {
  if (messages.length === 0) return false;
  if (isRunning) return false;
  if (!isHistoryLoaded) return false;

  const last = messages[messages.length - 1];
  return last.role === "user" && last.status === "sent";
}
