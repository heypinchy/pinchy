import { expectTypeOf, test } from "vitest";
import { reduceMessages, type MessageStatus } from "../message-status-reducer";

// Regression for #227: the reducer must accept the hook's superset WsMessage
// shape (optional status, string timestamp, plus images / error / retryable)
// without `as any` casts at the call site, and return the same element type.
test("reduceMessages is generic over the caller's message shape", () => {
  type HookWsMessage = {
    id: string;
    role: "user" | "assistant";
    content: string;
    images?: string[];
    timestamp?: string;
    status?: MessageStatus;
    retryable?: boolean;
  };

  const messages: HookWsMessage[] = [];
  const next = reduceMessages(messages, { type: "ack", clientMessageId: "x" });

  expectTypeOf(next).toEqualTypeOf<HookWsMessage[]>();
});
