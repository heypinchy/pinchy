import { expectTypeOf, test } from "vitest";
import { reduceMessages } from "../message-status-reducer";
import type { WsMessage } from "../use-ws-runtime";

// Regression for #227: the reducer must accept the hook's superset WsMessage
// shape (optional status, string timestamp, plus images / error / retryable)
// without `as any` casts at the call site, and return the same element type.
test("reduceMessages is generic over the caller's message shape", () => {
  const messages: WsMessage[] = [];
  const next = reduceMessages(messages, { type: "ack", clientMessageId: "x" });

  expectTypeOf(next).toEqualTypeOf<WsMessage[]>();
});
