/**
 * Unit tests for the shared Automations agent-scope gate.
 *
 * `canManageAgentWorkflows` (authz.test.ts) is the rule; this is the HTTP
 * preamble wrapped around it — read gate, then scope gate, then 403 — which
 * three routes used to carry as their own copy (#1087).
 *
 * The 403 wording gets its own cases on purpose. Collapsing the copies turned
 * user-visible copy into a defaulted parameter, so the drift this refactor
 * newly makes possible is a caller that omits the third argument and silently
 * downgrades "you may not create a workflow" to "you have no access". The
 * route-level counterpart lives in automations-create.integration.test.ts.
 *
 * `getAgentWithAccess` is mocked so the two layers can be driven apart; its own
 * behaviour (what it answers for a hidden agent) is pinned in
 * agent-access.test.ts, and the two composed for real in the three
 * automations-*.integration.test.ts suites. `assertAgentAccess` stays REAL —
 * the visibility facts these cases rest on must not become fiction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

const { getAgentWithAccessMock } = vi.hoisted(() => ({ getAgentWithAccessMock: vi.fn() }));

// Mocked so no test here opens a real connection at import time — agent-access
// imports @/db, and importOriginal below pulls the real module in.
vi.mock("@/db", () => ({ db: { select: vi.fn() } }));

vi.mock("@/lib/agent-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-access")>()),
  getAgentWithAccess: getAgentWithAccessMock,
}));

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

/** The read gate admits this agent — the actor can see it. */
function gateAdmits(agent: unknown) {
  getAgentWithAccessMock.mockResolvedValue(agent);
}

/** The read gate refuses, and this is the response it refuses with. */
function gateRefusesWith(response: NextResponse) {
  getAgentWithAccessMock.mockResolvedValue(response);
}

async function bodyOf(response: Response) {
  return (await response.json()) as { error?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveWorkflowAgent", () => {
  it("returns the agent when the actor owns it", async () => {
    gateAdmits(personalAgent);
    const result = await resolveWorkflowAgent("agent-1", { id: OWNER, role: "user" });
    expect(result).toEqual({ agent: personalAgent });
  });

  it("returns the agent for an admin on a shared agent", async () => {
    gateAdmits(sharedAgent);
    const result = await resolveWorkflowAgent("agent-2", { id: OTHER, role: "admin" });
    expect(result).toEqual({ agent: sharedAgent });
  });

  it("runs the read gate before the scope gate", async () => {
    // Order is the whole fix: the scope gate cannot answer first, because its
    // answer (403) is what discloses an agent the read gate would have hidden.
    gateAdmits(sharedAgent);
    await resolveWorkflowAgent("agent-2", { id: OWNER, role: "user" });
    expect(getAgentWithAccessMock).toHaveBeenCalledWith("agent-2", OWNER, "user");
  });

  it("passes the read gate's refusal through untouched", async () => {
    // Identity, not a re-derivation: whatever the read gate answers for an agent
    // the caller may not see — today a 404 indistinguishable from a missing one
    // — is what the caller gets. A resolver that rebuilt the response here could
    // reopen the oracle while agent-access stayed correct.
    const refusal = NextResponse.json({ error: "Agent not found" }, { status: 404 });
    gateRefusesWith(refusal);

    const result = await resolveWorkflowAgent("agent-1", { id: OTHER, role: "user" });
    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error).toBe(refusal);
  });

  it("answers 403 with the read-side default wording", async () => {
    gateAdmits(sharedAgent);
    const result = await resolveWorkflowAgent("agent-2", { id: OWNER, role: "user" });
    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(403);
    expect(await bodyOf(result.error)).toEqual({
      error: "You do not have access to this agent",
    });
  });

  it("answers 403 with the caller's wording when one is given", async () => {
    gateAdmits(sharedAgent);
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
});

/**
 * Which refusal an actor gets depends on WHICH gate turned them away, and both
 * legs assert the SAME (agent, actor) pair against the real `assertAgentAccess`
 * first. What would silently rot here is not the status code — it is the
 * visibility fact each argument is built on.
 *
 * These cases drive the mocked read gate from that real verdict, so they cannot
 * quietly start asserting a fiction: an agent `assertAgentAccess` admits is fed
 * to the resolver as admitted, and one it throws on as refused.
 */
describe("which gate refuses decides which answer", () => {
  const visibleSharedAgent = { ...sharedAgent, visibility: "all" };
  const hiddenRefusal = () => NextResponse.json({ error: "Agent not found" }, { status: 404 });

  it("answers 403 for an agent the visibility gate lets the actor see", async () => {
    // The honest 403, and the reason the fix is a layering rather than a blanket
    // 404: this is a shared agent the member has in their sidebar and chats with
    // daily. "Agent not found" about an agent on their screen is simply false.
    // `assertAgentAccess` throws on denial, so this not throwing IS the claim
    // that they can see it.
    expect(() =>
      assertAgentAccess(visibleSharedAgent, OWNER, "user", [], [], "paid")
    ).not.toThrow();

    gateAdmits(visibleSharedAgent);
    const result = await resolveWorkflowAgent("agent-2", { id: OWNER, role: "user" });
    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(403);
  });

  it("answers 404 for an agent the visibility gate hides", async () => {
    // Someone else's personal agent: hidden from every caller, admins included,
    // so a 403 would confirm an existence nothing else in the product discloses.
    // The scope gate must never get to speak about it.
    expect(() => assertAgentAccess(personalAgent, OTHER, "user", [], [], "paid")).toThrow();

    gateRefusesWith(hiddenRefusal());
    const result = await resolveWorkflowAgent("agent-1", { id: OTHER, role: "user" });
    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(404);
    expect(await bodyOf(result.error)).toEqual({ error: "Agent not found" });
  });

  it("answers a hidden agent exactly as it answers a missing one", async () => {
    // Both refusals come from the same gate, so they are the same response by
    // construction — pinned anyway, because that identity IS the property.
    gateRefusesWith(hiddenRefusal());
    const hidden = await resolveWorkflowAgent("agent-1", { id: OTHER, role: "user" });
    gateRefusesWith(hiddenRefusal());
    const missing = await resolveWorkflowAgent("ghost", { id: OTHER, role: "user" });

    if (!("error" in hidden) || !("error" in missing)) {
      throw new Error("expected error responses");
    }
    expect(hidden.error.status).toBe(missing.error.status);
    expect(await bodyOf(hidden.error)).toEqual(await bodyOf(missing.error));
  });
});

describe("resolveWorkflowAgentFromQuery", () => {
  it("answers 400 before reaching the access gate when agentId is missing", async () => {
    gateAdmits(personalAgent);
    const result = await resolveWorkflowAgentFromQuery(
      new Request("http://localhost/api/automations"),
      { id: OWNER, role: "user" }
    );
    if (!("error" in result)) throw new Error("expected an error response");
    expect(result.error.status).toBe(400);
    expect(await bodyOf(result.error)).toEqual({ error: "agentId is required" });
    expect(getAgentWithAccessMock).not.toHaveBeenCalled();
  });

  it("resolves the agentId out of the query string", async () => {
    gateAdmits(personalAgent);
    const result = await resolveWorkflowAgentFromQuery(
      new Request("http://localhost/api/automations?agentId=agent-1"),
      { id: OWNER, role: "user" }
    );
    expect(result).toEqual({ agent: personalAgent });
  });

  it("forwards a caller's 403 wording", async () => {
    gateAdmits(sharedAgent);
    const result = await resolveWorkflowAgentFromQuery(
      new Request("http://localhost/api/automations?agentId=agent-2"),
      { id: OWNER, role: "user" },
      "Custom refusal"
    );
    if (!("error" in result)) throw new Error("expected an error response");
    expect(await bodyOf(result.error)).toEqual({ error: "Custom refusal" });
  });
});
