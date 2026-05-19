import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldEmitModelUnavailableAudit,
  shouldEmitSilentStreamAudit,
  shouldEmitUpstreamFormatErrorAudit,
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

describe("shouldEmitUpstreamFormatErrorAudit", () => {
  beforeEach(() => {
    __resetModelUnavailableThrottleForTests();
  });

  it("emits the first event and suppresses repeats within TTL", () => {
    const now = Date.now();
    expect(
      shouldEmitUpstreamFormatErrorAudit("agent-1", "ollama-cloud/gemini-3-flash-preview", now)
    ).toBe(true);
    expect(
      shouldEmitUpstreamFormatErrorAudit(
        "agent-1",
        "ollama-cloud/gemini-3-flash-preview",
        now + 60_000
      )
    ).toBe(false);
    expect(
      shouldEmitUpstreamFormatErrorAudit(
        "agent-1",
        "ollama-cloud/gemini-3-flash-preview",
        now + 6 * 60_000
      )
    ).toBe(true);
  });

  it("tracks (agentId, model) pairs independently", () => {
    const now = Date.now();
    expect(shouldEmitUpstreamFormatErrorAudit("agent-1", "ollama-cloud/gemini-3", now)).toBe(true);
    expect(shouldEmitUpstreamFormatErrorAudit("agent-2", "ollama-cloud/gemini-3", now)).toBe(true);
    expect(shouldEmitUpstreamFormatErrorAudit("agent-1", "google/gemini-3-pro", now)).toBe(true);
  });

  it("is independent from the model-unavailable and silent-stream throttles", () => {
    // upstream_format_error is a separate operational signal (400 schema
    // rejection on tool-call replay). Sharing a throttle with model_unavailable
    // (5xx) or silent_stream (no event) would silently drop one of them when
    // they coincide within the same TTL for the same (agent, model).
    const now = Date.now();
    expect(shouldEmitModelUnavailableAudit("agent-1", "openai/gpt-x", now)).toBe(true);
    expect(shouldEmitSilentStreamAudit("agent-1", "openai/gpt-x", now + 60_000)).toBe(true);
    expect(shouldEmitUpstreamFormatErrorAudit("agent-1", "openai/gpt-x", now + 120_000)).toBe(true);
  });
});
