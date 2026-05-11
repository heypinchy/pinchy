import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldEmitModelUnavailableAudit,
  shouldEmitSilentStreamAudit,
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

describe("shouldEmitSilentStreamAudit", () => {
  beforeEach(() => {
    __resetModelUnavailableThrottleForTests();
  });

  it("emits the first event and suppresses repeats within TTL", () => {
    const now = Date.now();
    expect(shouldEmitSilentStreamAudit("agent-1", "ollama-cloud/x", now)).toBe(true);
    expect(shouldEmitSilentStreamAudit("agent-1", "ollama-cloud/x", now + 60_000)).toBe(false);
    expect(shouldEmitSilentStreamAudit("agent-1", "ollama-cloud/x", now + 6 * 60_000)).toBe(true);
  });

  it("tracks (agentId, model) pairs independently", () => {
    const now = Date.now();
    expect(shouldEmitSilentStreamAudit("agent-1", "openai/gpt-x", now)).toBe(true);
    expect(shouldEmitSilentStreamAudit("agent-2", "openai/gpt-x", now)).toBe(true);
    expect(shouldEmitSilentStreamAudit("agent-1", "openai/gpt-y", now)).toBe(true);
  });

  it("is independent from the model-unavailable throttle", () => {
    // Two failure modes for the same (agentId, model) within TTL must both
    // audit — they're distinct operational signals (5xx error chunk vs.
    // silent stream-end with no event at all). A shared throttle would lose
    // the second signal.
    const now = Date.now();
    expect(shouldEmitModelUnavailableAudit("agent-1", "openai/gpt-x", now)).toBe(true);
    expect(shouldEmitSilentStreamAudit("agent-1", "openai/gpt-x", now + 60_000)).toBe(true);
  });
});
