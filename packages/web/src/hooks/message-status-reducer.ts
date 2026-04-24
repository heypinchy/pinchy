export type MessageStatus = "sending" | "sent" | "failed";

export type WsMessage = {
  id: string;
  role: string;
  content: string;
  status: MessageStatus;
  timestamp: number;
};

type HistoryEntry = {
  role: string;
  content: string;
  /**
   * OpenClaw 0.5+ persists the per-message clientMessageId assigned by the
   * browser at send time. When present, history-reconcile matches on this
   * id — distinguishing duplicate-content messages unambiguously. When
   * absent (older OpenClaw, or server-originated entries such as Telegram),
   * the reducer falls back to content-based matching.
   */
  clientMessageId?: string;
};

export type Action =
  | { type: "user-send"; message: Omit<WsMessage, "status"> }
  | { type: "ack"; clientMessageId: string }
  | { type: "timeout"; clientMessageId: string }
  | { type: "history-reconcile"; history: HistoryEntry[] }
  | { type: "retry-resend"; clientMessageId: string };

export function reduceMessages(messages: WsMessage[], action: Action): WsMessage[] {
  switch (action.type) {
    case "user-send":
      return [...messages, { ...action.message, status: "sending" }];

    case "ack":
      return messages.map((msg) =>
        msg.id === action.clientMessageId && msg.status === "sending"
          ? { ...msg, status: "sent" }
          : msg
      );

    case "timeout":
      return messages.map((msg) =>
        msg.id === action.clientMessageId && msg.status === "sending"
          ? { ...msg, status: "failed" }
          : msg
      );

    case "history-reconcile": {
      const userHistory = action.history.filter((h) => h.role === "user");

      // Prefer id-based matching when the server provides clientMessageId on
      // history entries. This is the only way to distinguish duplicate-content
      // messages — e.g. the user sends "yes" twice, only one got through.
      const historyIds = new Set<string>();
      for (const h of userHistory) {
        if (h.clientMessageId !== undefined) historyIds.add(h.clientMessageId);
      }

      if (historyIds.size > 0) {
        return messages.map((msg) => {
          if (msg.status !== "sending") return msg;
          return { ...msg, status: historyIds.has(msg.id) ? "sent" : "failed" };
        });
      }

      // Fallback: content-set matching for history entries that lack
      // clientMessageId (older OpenClaw versions, or channels that didn't
      // originate the message — e.g. Telegram entries in a shared session).
      // Known limitation: cannot distinguish two sending messages with
      // identical content. The id-based path above is the remedy; this
      // fallback exists only so older sessions don't regress to "everything
      // looks failed".
      const historyContents = new Set(userHistory.map((h) => h.content));
      return messages.map((msg) => {
        if (msg.status !== "sending") return msg;
        return { ...msg, status: historyContents.has(msg.content) ? "sent" : "failed" };
      });
    }

    case "retry-resend":
      return messages.map((msg) =>
        msg.id === action.clientMessageId && msg.status === "failed"
          ? { ...msg, status: "sending" }
          : msg
      );
  }
}
