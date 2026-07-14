// Unit tests for the production RunAgent adapter (#139): one isolated OpenClaw
// run per claimed email. The OpenClaw client is mocked at the chat()/chatAbort()
// seam (same pattern as client-router.test.ts) — chunk shapes mirror what real
// Gateways emit, including the verified gotchas: `done` also follows `error`,
// and tool activity never appears as chunks.
import { describe, it, expect, vi, afterEach } from "vitest";

import { createOpenClawRunAgent } from "@/lib/email-workflows/run-adapter";
import { RunDeferredError, type WorkflowForDispatch } from "@/lib/email-workflows/dispatch";
import type { DispatchableEmail } from "@/lib/email-workflows/types";
import { inboxSessionKey } from "@/lib/session-key";

const workflow: WorkflowForDispatch = {
  id: "wf-1",
  agentId: "agent-1",
  connectionId: "conn-1",
  name: "File invoices",
  filter: {},
  action: "Draft a supplier bill in Odoo from the attached invoice.",
  recipientUserIds: ["u-1"],
};

const email: DispatchableEmail = {
  providerMessageId: "msg-77",
  from: "vendor@supplier.com",
  to: ["ap@acme.com"],
  subject: "Invoice 4711",
  folder: "INBOX",
  attachments: [{ contentType: "application/pdf", filename: "invoice.pdf" }],
  receivedAt: new Date("2026-07-14T09:00:00Z"),
};

const report = {
  status: "done",
  title: "1 invoice filed",
  content: "Drafted supplier bill for Invoice 4711.",
  outcome: { odooModel: "account.move", odooId: 7 },
};

type Chunk = { type: string; text: string; runId: string };

function stream(...chunks: Chunk[]) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function reportText(payload: unknown = report): string {
  return "All done.\n\n```json\n" + JSON.stringify(payload) + "\n```";
}

function makeClient() {
  return {
    chat: vi.fn(),
    chatAbort: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAdapter(
  client: ReturnType<typeof makeClient>,
  overrides: {
    loadAgentModel?: (agentId: string) => Promise<string | null>;
    waitForAgentReady?: (agentId: string) => Promise<boolean>;
    timeoutMs?: number;
  } = {}
) {
  return createOpenClawRunAgent({
    // The adapter only touches chat/chatAbort; the structural cast keeps the
    // mock honest about that seam.
    client: client as never,
    loadAgentModel: overrides.loadAgentModel ?? (async () => "ollama-cloud/gemini-3-flash"),
    waitForAgentReady: overrides.waitForAgentReady ?? (async () => true),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createOpenClawRunAgent — happy path", () => {
  it("runs one isolated chat and maps the report to a RunAgentResult", async () => {
    const client = makeClient();
    // The JSON block arrives split across chunks, as real streams deliver it.
    const text = reportText();
    client.chat.mockReturnValueOnce(
      stream(
        { type: "agent_start", text: "", runId: "run-9" },
        { type: "text", text: text.slice(0, 30), runId: "run-9" },
        { type: "text", text: text.slice(30), runId: "run-9" },
        { type: "done", text: "", runId: "run-9" }
      )
    );

    const result = await makeAdapter(client)({ workflow, email, ledgerId: "ledger-5" });

    expect(result).toEqual({
      status: "done",
      title: "1 invoice filed",
      content: "Drafted supplier bill for Invoice 4711.",
      outcome: { odooModel: "account.move", odooId: 7 },
      runId: "run-9",
    });
  });

  it("addresses the run at the isolated inbox session with the agent's real model", async () => {
    const client = makeClient();
    client.chat.mockReturnValueOnce(stream({ type: "text", text: reportText(), runId: "r" }));

    await makeAdapter(client)({ workflow, email, ledgerId: "ledger-5" });

    const [message, options] = client.chat.mock.calls[0];
    expect(options).toMatchObject({
      sessionKey: inboxSessionKey("agent-1", "ledger-5"),
      agentId: "agent-1",
      // Split on the FIRST '/': without the explicit pair the Gateway resolves
      // capability checks against the gateway-wide default model (#324).
      provider: "ollama-cloud",
      model: "gemini-3-flash",
    });
    expect(options.extraSystemPrompt).toContain('"status"');
    expect(options.extraSystemPrompt).toContain("no_action");
    // The task carries the workflow action plus the deterministic email
    // metadata; the agent reads the full email itself via its email tools.
    expect(message).toContain(workflow.action);
    expect(message).toContain("msg-77");
    expect(message).toContain("Invoice 4711");
    expect(message).toContain("vendor@supplier.com");
  });

  it("keeps the model id's own slashes intact when splitting provider/model", async () => {
    const client = makeClient();
    client.chat.mockReturnValueOnce(stream({ type: "text", text: reportText(), runId: "r" }));

    await makeAdapter(client, { loadAgentModel: async () => "openrouter/meta/llama-3-70b" })({
      workflow,
      email,
      ledgerId: "l",
    });

    expect(client.chat.mock.calls[0][1]).toMatchObject({
      provider: "openrouter",
      model: "meta/llama-3-70b",
    });
  });

  it("strips OpenClaw's <final> envelope before parsing the report", async () => {
    const client = makeClient();
    client.chat.mockReturnValueOnce(
      stream({ type: "text", text: `<final>${reportText()}</final>`, runId: "r" })
    );

    const result = await makeAdapter(client)({ workflow, email, ledgerId: "l" });

    expect(result.status).toBe("done");
  });

  it("maps a no_action report", async () => {
    const client = makeClient();
    client.chat.mockReturnValueOnce(
      stream({
        type: "text",
        text: reportText({ status: "no_action", title: "Nothing to file", content: "No invoice." }),
        runId: "r",
      })
    );

    const result = await makeAdapter(client)({ workflow, email, ledgerId: "l" });

    expect(result.status).toBe("no_action");
    expect(result.title).toBe("Nothing to file");
  });
});

describe("createOpenClawRunAgent — failure semantics", () => {
  it("throws on an error chunk even though a done chunk follows (done ≠ success)", async () => {
    const client = makeClient();
    // Verified real-Gateway sequence for a failed run: error, THEN done.
    client.chat.mockReturnValueOnce(
      stream(
        { type: "agent_start", text: "", runId: "r" },
        { type: "error", text: "provider rejected the request schema or tool payload", runId: "r" },
        { type: "done", text: "", runId: "r" }
      )
    );

    await expect(makeAdapter(client)({ workflow, email, ledgerId: "l" })).rejects.toThrow(
      /provider rejected/
    );
  });

  it("throws when the agent has no model configured", async () => {
    const client = makeClient();

    await expect(
      makeAdapter(client, { loadAgentModel: async () => null })({ workflow, email, ledgerId: "l" })
    ).rejects.toThrow(/model/);
    expect(client.chat).not.toHaveBeenCalled();
  });

  it("DEFERS (not fails) when the agent never becomes ready — a transient infra gap must be retryable", async () => {
    const client = makeClient();

    // RunDeferredError is the sentinel the dispatcher treats as "leave the row
    // processing for the reconciliation sweep", NOT as a terminal run failure.
    // The agent simply isn't in the runtime yet (a config reload can lag a
    // restart by 10–30 s); failing the email terminally would strand it, since
    // the sweep only retries `processing`/`deferred` rows, never `failed` ones.
    const promise = makeAdapter(client, { waitForAgentReady: async () => false })({
      workflow,
      email,
      ledgerId: "l",
    });

    await expect(promise).rejects.toBeInstanceOf(RunDeferredError);
    await expect(promise).rejects.toThrow(/runtime/);
    expect(client.chat).not.toHaveBeenCalled();
  });
});

describe("createOpenClawRunAgent — correction turn", () => {
  it("feeds the parse error back once in the same session and accepts the corrected reply", async () => {
    const client = makeClient();
    client.chat
      .mockReturnValueOnce(
        stream({ type: "text", text: "I filed the invoice, all good!", runId: "run-1" })
      )
      .mockReturnValueOnce(stream({ type: "text", text: JSON.stringify(report), runId: "run-2" }));

    const result = await makeAdapter(client)({ workflow, email, ledgerId: "ledger-5" });

    expect(result.title).toBe("1 invoice filed");
    expect(client.chat).toHaveBeenCalledTimes(2);
    const [correctionMessage, correctionOptions] = client.chat.mock.calls[1];
    // Same isolated session, so the model still has its own context.
    expect(correctionOptions.sessionKey).toBe(inboxSessionKey("agent-1", "ledger-5"));
    expect(correctionMessage).toMatch(/JSON/);
  });

  it("fails the run when the correction turn is also invalid", async () => {
    const client = makeClient();
    client.chat
      .mockReturnValueOnce(stream({ type: "text", text: "no json here", runId: "r1" }))
      .mockReturnValueOnce(stream({ type: "text", text: "still no json", runId: "r2" }));

    await expect(makeAdapter(client)({ workflow, email, ledgerId: "l" })).rejects.toThrow(
      /report/i
    );
    expect(client.chat).toHaveBeenCalledTimes(2);
  });
});

describe("createOpenClawRunAgent — watchdog", () => {
  it("aborts a hung run via chatAbort and throws", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    client.chat.mockReturnValueOnce(
      (async function* () {
        yield { type: "agent_start", text: "", runId: "run-hung" };
        // The stream never ends — a zombie run.
        await new Promise(() => {});
      })()
    );

    const pending = makeAdapter(client, { timeoutMs: 1000 })({ workflow, email, ledgerId: "l" });
    const expectation = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1500);
    await expectation;

    expect(client.chatAbort).toHaveBeenCalledWith(inboxSessionKey("agent-1", "l"), "run-hung");
  });
});
