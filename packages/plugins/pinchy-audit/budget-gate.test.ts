// @vitest-environment node
//
// The before_agent_run budget gate: Pinchy's blocking cost budgets enforced
// inside the OpenClaw runtime, so Telegram and every other channel is covered
// (plans/2026-10-19-budget-runtime-gate-design.md).
//
// Two runtime facts these tests encode, both verified in OpenClaw 2026.7.1:
// returning `undefined` from this hook is a BLOCK (not a pass), and a throw or
// a hook timeout is a block too. So the handler must always return a decision
// object and must never throw.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;

const BLOCK_MESSAGE =
  "Knowledge Base has used its monthly budget. It's available again next month, or sooner if your admin raises the budget.";

async function registerGate() {
  const on = vi.fn();
  const logger = { warn: vi.fn() };
  const { default: plugin } = await import("./index");
  plugin.register({
    pluginConfig: { apiBaseUrl: "http://pinchy:7777/", gatewayToken: "gw-token" },
    logger,
    on,
  } as never);
  const call = on.mock.calls.find((c) => c[0] === "before_agent_run");
  expect(call, "before_agent_run must be registered").toBeDefined();
  return { gate: call![1] as Handler, logger };
}

const EVENT = { prompt: "Wie hoch ist das Budget?", messages: [], channelId: "telegram" };
const CTX = {
  agentId: "agent-1",
  sessionKey: "agent:agent-1:telegram:direct:999888777",
  channel: "telegram",
  senderId: "999888777",
  trigger: "user",
};

function answer(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => "",
  };
}

describe("pinchy-audit before_agent_run budget gate", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer({ blocked: false })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks Pinchy with the agent and the channel context, bounded by a timeout", async () => {
    const { gate } = await registerGate();
    await gate(EVENT, CTX);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://pinchy:7777/api/internal/budgets/check");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gw-token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      agentId: "agent-1",
      sessionKey: CTX.sessionKey,
      channel: "telegram",
      senderId: "999888777",
      trigger: "user",
    });
  });

  it("never sends the conversation to Pinchy — only who and where", async () => {
    const { gate } = await registerGate();
    await gate({ ...EVENT, systemPrompt: "secret system prompt" }, CTX);
    const body = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string;
    expect(body).not.toContain("Budget?");
    expect(body).not.toContain("secret system prompt");
  });

  it("returns an explicit pass — undefined would block the run", async () => {
    const { gate } = await registerGate();
    expect(await gate(EVENT, CTX)).toEqual({ outcome: "pass" });
  });

  it("blocks with Pinchy's sentence when a blocking budget is used up", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ blocked: true, message: BLOCK_MESSAGE }) as never);
    const { gate } = await registerGate();
    expect(await gate(EVENT, CTX)).toEqual({
      outcome: "block",
      reason: "budget_exhausted",
      message: BLOCK_MESSAGE,
      category: "cost_limit",
    });
  });

  it("reads the agent from the session key when the context carries no agentId", async () => {
    const { gate } = await registerGate();
    await gate(EVENT, { sessionKey: "agent:agent-7:direct:user-1" });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.agentId).toBe("agent-7");
  });

  it("passes a run it cannot attribute to an agent without asking", async () => {
    const { gate } = await registerGate();
    expect(await gate(EVENT, {})).toEqual({ outcome: "pass" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caches a pass per agent for a short while, then asks again", async () => {
    const { gate } = await registerGate();
    await gate(EVENT, CTX);
    await gate(EVENT, CTX);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Another agent is its own question.
    await gate(EVENT, { ...CTX, agentId: "agent-2", sessionKey: undefined });
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-10-19T10:00:16Z"));
    await gate(EVENT, CTX);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("asks again on every turn while blocked, so a raised budget reopens on the next message", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      answer({ blocked: true, message: BLOCK_MESSAGE }) as never
    );
    const { gate } = await registerGate();
    expect((await gate(EVENT, CTX)) as { outcome: string }).toMatchObject({ outcome: "block" });

    // The admin raised the budget a second later.
    expect(await gate(EVENT, CTX)).toEqual({ outcome: "pass" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  describe("when Pinchy cannot be asked", () => {
    it("fails open when it has never heard otherwise, and says so in the log", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("connect ECONNREFUSED"));
      const { gate, logger } = await registerGate();
      expect(await gate(EVENT, CTX)).toEqual({ outcome: "pass" });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    });

    it("keeps blocking an agent whose last answer was a block", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(answer({ blocked: true, message: BLOCK_MESSAGE }) as never)
        .mockRejectedValue(new Error("connect ECONNREFUSED"));
      const { gate } = await registerGate();
      await gate(EVENT, CTX);
      expect(await gate(EVENT, CTX)).toEqual({
        outcome: "block",
        reason: "budget_exhausted",
        message: BLOCK_MESSAGE,
        category: "cost_limit",
      });
    });

    it("treats a 5xx like an unreachable Pinchy", async () => {
      vi.mocked(fetch).mockResolvedValue(answer({ error: "boom" }, 503) as never);
      const { gate, logger } = await registerGate();
      expect(await gate(EVENT, CTX)).toEqual({ outcome: "pass" });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("503"));
    });

    it("treats an answer it cannot read like an unreachable Pinchy", async () => {
      vi.mocked(fetch).mockResolvedValue(answer({ blocked: "yes" }) as never);
      const { gate } = await registerGate();
      expect(await gate(EVENT, CTX)).toEqual({ outcome: "pass" });
    });

    it("never throws — a throw is a block in the runtime", async () => {
      vi.mocked(fetch).mockImplementation(() => {
        throw new TypeError("fetch is broken");
      });
      const { gate } = await registerGate();
      await expect(gate(EVENT, CTX)).resolves.toEqual({ outcome: "pass" });
    });

    it("bounds its own wait well inside OpenClaw's 15s hook timeout", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const { gate } = await registerGate();
      await gate(EVENT, CTX);
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout.mock.calls[0][0]).toBeLessThanOrEqual(5_000);
    });
  });

  it("sends only context fields that are strings", async () => {
    const { gate } = await registerGate();
    await gate(EVENT, { ...CTX, senderId: 999888777, trigger: null });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("senderId");
    expect(body).not.toHaveProperty("trigger");
    expect(body.channel).toBe("telegram");
  });

  describe("during an outage", () => {
    it("pauses before asking again, so a down Pinchy does not cost every run 3s", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("connect ECONNREFUSED"));
      const { gate } = await registerGate();
      await gate(EVENT, CTX);
      await gate(EVENT, { ...CTX, agentId: "agent-2", sessionKey: undefined });
      expect(fetch).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-10-19T10:00:11Z"));
      await gate(EVENT, CTX);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("keeps a block through the pause", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(answer({ blocked: true, message: BLOCK_MESSAGE }) as never)
        .mockRejectedValue(new Error("connect ECONNREFUSED"));
      const { gate } = await registerGate();
      await gate(EVENT, CTX);
      await gate(EVENT, CTX);
      expect(await gate(EVENT, CTX)).toMatchObject({ outcome: "block", message: BLOCK_MESSAGE });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("warns once per outage, and says when Pinchy answers again", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("connect ECONNREFUSED"));
      const { gate, logger } = await registerGate();
      await gate(EVENT, CTX);
      vi.setSystemTime(new Date("2026-10-19T10:00:11Z"));
      await gate(EVENT, CTX);
      vi.setSystemTime(new Date("2026-10-19T10:00:22Z"));
      await gate(EVENT, CTX);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      vi.mocked(fetch).mockResolvedValue(answer({ blocked: false }) as never);
      vi.setSystemTime(new Date("2026-10-19T10:00:33Z"));
      await gate(EVENT, CTX);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining("answers again"));
    });

    it("names a rejection Pinchy will repeat as budgets not being enforced", async () => {
      // A 401 is not an outage that heals: a rotated token switches the gate
      // off until someone looks, so the log must say exactly that.
      vi.mocked(fetch).mockResolvedValue(answer({ error: "Unauthorized" }, 401) as never);
      const { gate, logger } = await registerGate();
      expect(await gate(EVENT, CTX)).toEqual({ outcome: "pass" });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("blocking budgets are not enforced")
      );
    });
  });
});
