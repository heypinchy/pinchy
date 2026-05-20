import type { JsonlEvent } from "./jsonl-parser";

export interface ToolCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
  result?: unknown;
  errorMessage?: string;
  durationMs?: number;
}

export interface AssistantResponse {
  text: string;
  finishReason?: string;
  model?: string;
  provider?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  toolCalls?: ToolCall[];
  timestamp?: number;
}

export interface Turn {
  index: number;
  // Always "user" — each Turn is user-initiated and contains both userMessage and
  // the assistantResponse that followed. The field exists for downstream code that
  // treats turns as a flat role-tagged sequence.
  role: "user" | "assistant";
  userMessage?: { text: string; timestamp?: number };
  assistantResponse?: AssistantResponse;
}

interface SnapshotContentPart {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  text?: unknown;
}

interface SnapshotMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  timestamp?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseTimestamp(ts: unknown): number | undefined {
  const str = asString(ts);
  if (!str) return undefined;
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : undefined;
}

function findFinishReason(
  snapshot: SnapshotMessage[],
  data: Record<string, unknown>
): string | undefined {
  if (data.aborted === true) return "aborted";
  if (data.timedOut === true) return "timeout";
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const msg = snapshot[i];
    if (msg.role !== "assistant") continue;
    const stopReason = asString(msg.stopReason);
    if (stopReason) return stopReason;
  }
  return undefined;
}

function collectToolCalls(snapshot: SnapshotMessage[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const msg of snapshot) {
    if (msg.role !== "assistant") continue;
    for (const part of asArray(msg.content) as SnapshotContentPart[]) {
      if (!part || part.type !== "toolCall") continue;
      const toolCallId = asString(part.id);
      const name = asString(part.name);
      if (!toolCallId || !name) continue;
      calls.push({ toolCallId, name, arguments: part.arguments });
    }
  }

  for (const call of calls) {
    for (const msg of snapshot) {
      if (msg.role !== "toolResult") continue;
      if (asString(msg.toolCallId) !== call.toolCallId) continue;
      call.result = msg.content;
      if (msg.isError === true) {
        const contentArr = asArray(msg.content) as SnapshotContentPart[];
        const firstText = contentArr.find((p) => p?.type === "text");
        call.errorMessage = asString(firstText?.text) ?? "tool error";
      }
      break;
    }
  }

  return calls;
}

function buildTurn(event: Record<string, unknown>, index: number): Turn {
  const data = asRecord(event.data) ?? {};
  const timestamp = parseTimestamp(event.ts);
  const finalPromptText = asString(data.finalPromptText) ?? "";
  const assistantTexts = asArray(data.assistantTexts).filter(
    (v): v is string => typeof v === "string"
  );
  const snapshot = asArray(data.messagesSnapshot) as SnapshotMessage[];

  const usageRecord = asRecord(data.usage);
  const usage = usageRecord
    ? {
        inputTokens: asNumber(usageRecord.input),
        outputTokens: asNumber(usageRecord.output),
      }
    : undefined;

  const toolCalls = collectToolCalls(snapshot);

  const assistantResponse: AssistantResponse = {
    text: assistantTexts.join("\n\n"),
    model: asString(event.modelId),
    provider: asString(event.provider),
    timestamp,
    finishReason: findFinishReason(snapshot, data),
  };

  if (usage) assistantResponse.usage = usage;
  if (toolCalls.length > 0) assistantResponse.toolCalls = toolCalls;

  const firstSnapshotMessage = snapshot[0];
  const userMessageTimestamp =
    firstSnapshotMessage?.role === "user" ? asNumber(firstSnapshotMessage.timestamp) : undefined;

  return {
    index,
    role: "user",
    userMessage: { text: finalPromptText, timestamp: userMessageTimestamp },
    assistantResponse,
  };
}

export function extractTurns(events: JsonlEvent[]): Turn[] {
  return events
    .filter((event) => event.type === "model.completed")
    .map((event, index) => buildTurn(event, index));
}
