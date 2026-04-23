export type MessageStatus = "sending" | "sent" | "failed";

export type WsMessage = {
  id: string;
  role: string;
  content: string;
  status: MessageStatus;
  timestamp: number;
};

type HistoryEntry = {
  id: string;
  role: string;
  content: string;
  timestamp: number;
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
      const historyIds = new Set(action.history.map((h) => h.id));
      return messages.map((msg) => {
        if (msg.status !== "sending") return msg;
        return { ...msg, status: historyIds.has(msg.id) ? "sent" : "failed" };
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
