/**
 * Unit tests for the shared Automations agent-scope gate.
 *
 * `canManageAgentWorkflows` (authz.test.ts) is the rule; this is the HTTP
 * preamble wrapped around it — load, 404, gate, 403 — which three routes used
 * to carry as their own copy (#1087).
 *
 * The 403 wording gets its own cases on purpose. Collapsing the copies turned
 * user-visible copy into a defaulted parameter, so the drift this refactor
 * newly makes possible is a caller that omits the third argument and silently
 * downgrades "you may not create a workflow" to "you have no access". The
 * route-level counterpart lives in automations-create.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => ({ db: { select: vi.fn() } }));

import { db } from "@/db";
import { assertAgentAccess } from "@/lib/agent-access";
import {
  resolveWorkflowAgent,
  resolveWorkflowAgentFromQuery,
} from "@/lib/email-workflows/resolve-agent";

const OWNER = "user-owner";
const OTHER = "user-other";

const personalAgent = {
  id: "agent-1",
  name: "Owner's assistant",
  isPersonal: true,
  ownerId: OWNER,
};
const sharedAgent = { id: "agent-2", name: "Team bot", isPersonal: false, ownerId: null };

/** Stub the `select().from().where()` chain with the row the lookup finds. */
function mockLookup(row: unknown | undefined) {
  const where = vi.fn().mockResolvedValue(row === undefined ? [] : [row]);
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
  return { from, where };
}

async function bodyOf(response: Response) {
  return (await response.json()) as { error?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveWorkflowAgent", () => {
  it("returns the agent when the actor owns it", async () => {
    mockLookup(personalAgent);
    const result = await resolveWorkflowAgent("agent-1", { id: OWNER, role: "user" });
    expect(result).toEqual({ agent: personalAgent });
  });

  it("returns the agent for an admin on a shared agent", async () => {
    mockLookup(sharedAgent);
    const result = await resolveWorkflowAgent("agent-2", { id: OTHER, role: "admin" });
    expect(result).toEqual({ agent: sharedAgent });
  });

  it("answers 404 when no agent matches", async () => {
    mockLookup(undefined);
    const result = await resolveWorkflowAgent("ghost", { id: OWNER, role: "user" });
    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(404);
    expect(await bodyOf(result.error)).toEqual({ error: "Agent not found" });
  });

  it("answers 403 with the read-side default wording", async () => {
    mockLookup(sharedAgent);
    const result = await resolveWorkflowAgent("agent-2", { id: OWNER, role: "user" });
    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(403);
    expect(await bodyOf(result.error)).toEqual({
      error: "You do not have access to this agent",
    });
  });

  it("answers 403 with the caller's wording when one is given", async () => {
    mockLookup(sharedAgent);
    const result = await resolveWorkflowAgent(
      "agent-2",
      { id: OWNER, role: "user" },
      "You do not have permission to create a workflow on this agent"
    );
    if (!("error" in result)) throw new Error("expected an error response");
    expect(await bodyOf(result.error)).toEqual({
      error: "You do not have permission to create a workflow on this agent",
    });
  });

  it("refuses someone else's personal agent", async () => {
    mockLookup(personalAgent);
    const result = await resolveWorkflowAgent("agent-1", { id: OTHER, role: "user" });
    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(403);
  });
});

/**
 * This gate answers 403 where `loadChatPageAgent` answers 404 for a refusal,
 * which reads as a contradiction now that both live one directory apart. It is
 * deliberate, and the reasoning is on `resolveWorkflowAgent` — but reasoning in
 * a comment is not a check, so pin the two legs it rests on. Both assert the
 * SAME (agent, actor) pair against BOTH gates: what would silently rot here is
 * not the status code, it is the visibility fact the argument is built on.
 */
describe("the deliberate 403-not-404 split", () => {
  const visibleSharedAgent = { ...sharedAgent, visibility: "all" };

  it("answers 403 for an agent the visibility gate lets the actor see", async () => {
    // The honest leg. A 404 here would deny an agent this member has in their
    // sidebar and chats with — `assertAgentAccess` throws on denial, so this
    // not throwing IS the claim that they can see it.
    expect(() =>
      assertAgentAccess(visibleSharedAgent, OWNER, "user", [], [], "paid")
    ).not.toThrow();

    mockLookup(visibleSharedAgent);
    const result = await resolveWorkflowAgent("agent-2", { id: OWNER, role: "user" });
    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(403);
  });

  it("answers 403 for an agent the visibility gate hides — the knowingly-open leg", async () => {
    // Someone else's personal agent: refused by both gates, so 403-vs-404 here
    // really does confirm existence. Left open on the reasoning in the
    // docblock, and asserted rather than assumed so that "this leg is the
    // hidden one" cannot quietly stop being true.
    expect(() => assertAgentAccess(personalAgent, OTHER, "user", [], [], "paid")).toThrow();

    mockLookup(personalAgent);
    const result = await resolveWorkflowAgent("agent-1", { id: OTHER, role: "user" });
    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(403);
  });
});

describe("resolveWorkflowAgentFromQuery", () => {
  it("answers 400 before touching the database when agentId is missing", async () => {
    mockLookup(personalAgent);
    const result = await resolveWorkflowAgentFromQuery(
      new Request("http://localhost/api/automations"),
      { id: OWNER, role: "user" }
    );
    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(400);
    expect(await bodyOf(result.error)).toEqual({ error: "agentId is required" });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("resolves the agentId out of the query string", async () => {
    mockLookup(personalAgent);
    const result = await resolveWorkflowAgentFromQuery(
      new Request("http://localhost/api/automations?agentId=agent-1"),
      { id: OWNER, role: "user" }
    );
    expect(result).toEqual({ agent: personalAgent });
  });

  it("forwards a caller's 403 wording", async () => {
    mockLookup(sharedAgent);
    const result = await resolveWorkflowAgentFromQuery(
      new Request("http://localhost/api/automations?agentId=agent-2"),
      { id: OWNER, role: "user" },
      "Custom refusal"
    );
    if (!("error" in result)) throw new Error("expected an error response");
    expect(await bodyOf(result.error)).toEqual({ error: "Custom refusal" });
  });
});
