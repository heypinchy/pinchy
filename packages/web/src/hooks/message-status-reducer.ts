export type MessageStatus = "sending" | "sent" | "failed";

/**
 * Structural constraint for the reducer's input. The reducer only reads `id`
 * and `content` and only writes `status` — anything else on the message is
 * preserved verbatim. Generic over the caller's actual message shape so the
 * reducer can operate on hook-side supersets (with `images`, `error`, etc.)
 * without `as any` casts at the dispatch site (#227).
 */
type ReducerMessage = {
  id: string;
  content: string;
  status?: MessageStatus;
};

type HistoryEntry = {
  role: string;
  content: string;
};

export type Action =
  | { type: "ack"; clientMessageId: string }
  | { type: "timeout"; clientMessageId: string }
  | { type: "history-reconcile"; history: HistoryEntry[] }
  | { type: "retry-resend"; clientMessageId: string };

export function reduceMessages<M extends ReducerMessage>(messages: M[], action: Action): M[] {
  switch (action.type) {
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
      const historyContents = new Set(
        action.history.filter((h) => h.role === "user").map((h) => h.content)
      );
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
