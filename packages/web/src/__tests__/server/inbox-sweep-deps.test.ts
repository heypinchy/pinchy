// Unit tests for the sweep's production dependency wiring.
//
// The sweep engine and the OpenClaw run adapter are both covered by their own
// tests against injected fakes. What is proven here is the seam between them:
// the two dependencies this module builds for real (the agent's model, read
// from Pinchy's DB; the runtime-readiness gate, asked of the live Gateway).
//
// The readiness gate carries a load-bearing decision — see the guard below.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAgentFindFirst } = vi.hoisted(() => ({
  mockAgentFindFirst: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: { query: { agents: { findFirst: mockAgentFindFirst } } },
}));

import { createEmailPort } from "@/lib/email-workflows/port";
import {
  buildSweepDeps,
  createAgentReadinessGate,
  loadAgentModel,
} from "@/server/inbox-sweep-deps";

/** The slice of the gateway client the sweep's deps actually touch. */
function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    chat: vi.fn(),
    chatAbort: vi.fn(),
    isConnected: true,
    hasMethod: vi.fn().mockReturnValue(true),
    agents: { list: vi.fn().mockResolvedValue({ agents: [] }) },
    ...overrides,
  } as unknown as Parameters<typeof buildSweepDeps>[0];
}

describe("loadAgentModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the agent's configured model from Pinchy's DB", async () => {
    mockAgentFindFirst.mockResolvedValue({ model: "ollama-cloud/gemini-3-flash" });

    await expect(loadAgentModel("agent-1")).resolves.toBe("ollama-cloud/gemini-3-flash");
  });

  it("answers null for an agent that no longer exists", async () => {
    // The run adapter turns null into a clear "no model configured" failure.
    // Answering a bogus default instead would dispatch against the
    // gateway-wide model and silently mis-attribute the run (#324).
    mockAgentFindFirst.mockResolvedValue(undefined);

    await expect(loadAgentModel("gone")).resolves.toBeNull();
  });
});

describe("createAgentReadinessGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports ready once the agent is present in the runtime", async () => {
    const client = makeClient({
      agents: { list: vi.fn().mockResolvedValue({ agents: [{ id: "agent-1" }] }) },
    });

    await expect(createAgentReadinessGate(client)("agent-1")).resolves.toBe(true);
  });

  it("reports NOT ready when the agent never appears within the deadline", async () => {
    // A real miss must stay `false`: the adapter defers, the row stays
    // `processing`, and the next sweep retries it. Nothing is lost.
    const client = makeClient();

    await expect(createAgentReadinessGate(client, { deadlineMs: 0 })("agent-1")).resolves.toBe(
      false
    );
  });

  it("reports ready when the Gateway cannot answer readiness at all", async () => {
    // LOAD-BEARING. `waitForAgentInRuntime` returns false for TWO different
    // things: "the agent isn't there yet" and "this Gateway has no agents.list,
    // so readiness is unobservable". The adapter treats false as "defer".
    //
    // Conflating them would be catastrophic and silent: on a Gateway without
    // agents.list every email would be claimed, deferred, reset by the next
    // sweep, re-claimed, deferred again — forever — while the workflow happily
    // reports `active` and not one mail is ever processed.
    //
    // Unobservable is not "no". Proceed and let the run answer: a genuinely
    // unknown agent id fails that run loudly instead of looping in silence.
    const list = vi.fn().mockResolvedValue({ agents: [] });
    const client = makeClient({
      hasMethod: vi.fn().mockReturnValue(false),
      agents: { list },
    });

    await expect(createAgentReadinessGate(client)("agent-1")).resolves.toBe(true);
    expect(list).not.toHaveBeenCalled();
  });

  it("reports NOT ready while the Gateway is disconnected", async () => {
    // LOAD-BEARING, and the reason `isConnected` is consulted before hasMethod:
    // the client's advertised-method list is populated at the hello-ok
    // handshake and is EMPTY until then, so a disconnected Gateway and an old
    // one are indistinguishable through hasMethod alone.
    //
    // Reading a disconnected Gateway as "unobservable, proceed" would claim the
    // email, fail the chat, and — since the dispatcher makes any run throw
    // terminal — mark a never-examined mail `failed` and notify the user about
    // it. Deferring instead costs one cadence and loses nothing.
    //
    // This bites on the ordinary path: the first sweep fires 30 s after boot,
    // which a cold start or a config.apply cascade can easily outlast.
    const list = vi.fn().mockResolvedValue({ agents: [] });
    const client = makeClient({
      isConnected: false,
      hasMethod: vi.fn().mockReturnValue(false),
      agents: { list },
    });

    await expect(createAgentReadinessGate(client)("agent-1")).resolves.toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("buildSweepDeps", () => {
  it("reaches real mailboxes through createEmailPort", async () => {
    // The sweep is only as real as its port: wired to anything else, every
    // pass would list an empty mailbox and report a clean bill of health.
    const deps = buildSweepDeps(makeClient());

    expect(deps.createPort).toBe(createEmailPort);
    expect(typeof deps.runAgent).toBe("function");
  });
});
