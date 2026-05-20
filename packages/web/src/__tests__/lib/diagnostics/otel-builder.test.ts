import { describe, it, expect } from "vitest";
import { buildOtelSpans } from "@/lib/diagnostics/otel-builder";
import type { Turn } from "@/lib/diagnostics/turn-extractor";

const sampleTurn: Turn = {
  index: 0,
  role: "user",
  userMessage: { text: "hi", timestamp: 1716000000000 },
  assistantResponse: {
    text: "hello",
    finishReason: "stop",
    model: "claude-opus-4-7",
    provider: "anthropic",
    usage: { inputTokens: 10, outputTokens: 5 },
    toolCalls: [
      { toolCallId: "tc1", name: "docs_list", arguments: { q: "x" }, result: { docs: [] } },
    ],
    timestamp: 1716000001000,
  },
};

describe("buildOtelSpans", () => {
  it("maps assistant turn to a gen_ai-attributed span", () => {
    const spans = buildOtelSpans([sampleTurn]);
    expect(spans).toHaveLength(1);
    const attrs = spans[0].attributes;
    expect(attrs["gen_ai.provider.name"]).toBe("anthropic");
    expect(attrs["gen_ai.request.model"]).toBe("claude-opus-4-7");
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(10);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(5);
  });

  it("includes input and output messages in OTel shape", () => {
    const spans = buildOtelSpans([sampleTurn]);
    const attrs = spans[0].attributes;
    expect(attrs["gen_ai.input.messages"]).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(attrs["gen_ai.output.messages"]).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "hello" }] },
    ]);
  });

  it("includes tool calls with arguments and result", () => {
    const spans = buildOtelSpans([sampleTurn]);
    const attrs = spans[0].attributes;
    expect(attrs["gen_ai.tool.call.arguments"]).toEqual([
      { id: "tc1", name: "docs_list", arguments: { q: "x" } },
    ]);
    expect(attrs["gen_ai.tool.call.result"]).toEqual([
      { id: "tc1", name: "docs_list", result: { docs: [] } },
    ]);
  });

  it("skips turns without an assistant response", () => {
    const userOnly: Turn = { index: 0, role: "user", userMessage: { text: "hi" } };
    expect(buildOtelSpans([userOnly])).toHaveLength(0);
  });
});
