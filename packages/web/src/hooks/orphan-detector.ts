import { stripTrailingPlaceholder } from "./in-flight-placeholder";

type MessageRole = "user" | "assistant";
type MessageStatus = "sent" | "sending" | "failed" | undefined;

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  error?: unknown;
}

interface OrphanContext {
  isRunning: boolean;
  isHistoryLoaded: boolean;
}

/**
 * Returns true when the last user message was sent but the agent has no
 * response and is not currently running — indicating an orphaned message
 * that needs a retry (Case B retry bubble).
 *
 * The in-flight placeholder the send path appends is a client-only artifact,
 * not an agent reply — the detector looks through it. A trailing empty ERROR
 * bubble is different: that turn already failed visibly and carries its own
 * retry affordance.
 */
export function isOrphaned(
  messages: Message[],
  { isRunning, isHistoryLoaded }: OrphanContext
): boolean {
  if (messages.length === 0) return false;
  if (isRunning) return false;
  if (!isHistoryLoaded) return false;

  const effective = stripTrailingPlaceholder(messages);
  const last = effective[effective.length - 1];
  return !!last && last.role === "user" && last.status === "sent";
}
