import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldEmitModelUnavailableAudit,
  __resetModelUnavailableThrottleForTests,
} from "@/server/model-unavailable-throttle";

describe("shouldEmitModelUnavailableAudit", () => {
  beforeEach(() => {
    __resetModelUnavailableThrottleForTests();
  });

  it("emits the first event and suppresses repeats within TTL", () => {
    const now = Date.now();
    expect(shouldEmitModelUnavailableAudit("agent-1", "ollama-cloud/x", now)).toBe(true);
    expect(shouldEmitModelUnavailableAudit("agent-1", "ollama-cloud/x", now + 60_000)).toBe(false);
    expect(shouldEmitModelUnavailableAudit("agent-1", "ollama-cloud/x", now + 6 * 60_000)).toBe(
      true
    );
  });

  it("tracks (agentId, model) pairs independently", () => {
    const now = Date.now();
    expect(shouldEmitModelUnavailableAudit("agent-1", "openai/gpt-x", now)).toBe(true);
    expect(shouldEmitModelUnavailableAudit("agent-2", "openai/gpt-x", now)).toBe(true);
    expect(shouldEmitModelUnavailableAudit("agent-1", "openai/gpt-y", now)).toBe(true);
  });
});
