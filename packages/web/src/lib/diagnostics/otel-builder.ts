import type { Turn } from "./turn-extractor";

export interface OtelSpan {
  name: string;
  attributes: Record<string, unknown>;
}

export function buildOtelSpans(turns: Turn[]): OtelSpan[] {
  return turns.flatMap((turn) => {
    if (!turn.assistantResponse) return [];
    const r = turn.assistantResponse;
    const attrs: Record<string, unknown> = {
      "gen_ai.provider.name": r.provider,
      "gen_ai.request.model": r.model,
      "gen_ai.response.finish_reasons": r.finishReason ? [r.finishReason] : undefined,
      "gen_ai.usage.input_tokens": r.usage?.inputTokens,
      "gen_ai.usage.output_tokens": r.usage?.outputTokens,
      "gen_ai.input.messages": turn.userMessage
        ? [{ role: "user", parts: [{ type: "text", content: turn.userMessage.text }] }]
        : undefined,
      "gen_ai.output.messages": [{ role: "assistant", parts: [{ type: "text", content: r.text }] }],
    };
    if (r.toolCalls && r.toolCalls.length > 0) {
      attrs["gen_ai.tool.call.arguments"] = r.toolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.name,
        arguments: tc.arguments,
      }));
      attrs["gen_ai.tool.call.result"] = r.toolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.name,
        result: tc.result,
      }));
    }
    return [
      {
        name: "agent.turn",
        attributes: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined)),
      },
    ];
  });
}
