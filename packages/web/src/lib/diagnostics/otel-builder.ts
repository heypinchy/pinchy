import type { Turn } from "./turn-extractor";

export interface OtelSpan {
  name: string;
  /**
   * ISO timestamps from the turn's JSONL events (user message → start, model
   * completion → end). Optional: older transcripts may lack `ts` fields.
   * Without these an analyst cannot correlate spans with audit entries or
   * wall-clock logs.
   */
  startTime?: string;
  endTime?: string;
  attributes: Record<string, unknown>;
}

function toIso(epochMs: number | undefined): string | undefined {
  return epochMs === undefined ? undefined : new Date(epochMs).toISOString();
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
    const startTime = toIso(turn.userMessage?.timestamp);
    const endTime = toIso(r.timestamp);
    return [
      {
        name: "agent.turn",
        ...(startTime !== undefined ? { startTime } : {}),
        ...(endTime !== undefined ? { endTime } : {}),
        attributes: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined)),
      },
    ];
  });
}
