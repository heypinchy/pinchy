// Unit tests for the workflow scope gate (design §7, #705) — the single source
// of truth every workflow route (create / list / enable-disable / delete)
// shares. The route integration tests exercise the wiring (own-personal allow,
// shared forbid); this pins the full RBAC matrix at the one place the rule
// lives, so the load-bearing `ownerId === actor.id` term can't silently drop
// out. In particular a member acting on *someone else's* personal agent — the
// branch the route suites don't cover — must be forbidden.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => {
  const where = vi.fn();
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } };
});

import { db } from "@/db";
import { canManageAgentWorkflows, requireManageableAgent } from "@/lib/email-workflows/authz";

const OWNER = "user-owner";
const OTHER = "user-other";

describe("canManageAgentWorkflows", () => {
  describe("member (non-admin)", () => {
    const member = { id: OWNER, role: "member" as const };

    it("may manage a personal agent they own", () => {
      expect(canManageAgentWorkflows({ isPersonal: true, ownerId: OWNER }, member)).toBe(true);
    });

    it("may NOT manage another member's personal agent", () => {
      expect(canManageAgentWorkflows({ isPersonal: true, ownerId: OTHER }, member)).toBe(false);
    });

    it("may NOT manage a shared agent", () => {
      expect(canManageAgentWorkflows({ isPersonal: false, ownerId: null }, member)).toBe(false);
    });

    it("may NOT manage an ownerless personal agent", () => {
      // Defensive: isPersonal with a null owner is not a shape the app writes,
      // but the gate must still deny it rather than throw or coerce.
      expect(canManageAgentWorkflows({ isPersonal: true, ownerId: null }, member)).toBe(false);
    });
  });

  describe("admin", () => {
    const admin = { id: OWNER, role: "admin" as const };

    it("may manage any shared agent", () => {
      expect(canManageAgentWorkflows({ isPersonal: false, ownerId: null }, admin)).toBe(true);
    });

    it("may manage another user's personal agent", () => {
      expect(canManageAgentWorkflows({ isPersonal: true, ownerId: OTHER }, admin)).toBe(true);
    });
  });

  it("treats a missing/null role as a non-admin member", () => {
    expect(
      canManageAgentWorkflows({ isPersonal: false, ownerId: null }, { id: OWNER, role: null })
    ).toBe(false);
    expect(
      canManageAgentWorkflows({ isPersonal: true, ownerId: OWNER }, { id: OWNER, role: undefined })
    ).toBe(true);
  });
});

// requireManageableAgent is the load-then-gate helper the automations routes
// (list, create, connections picker) now share instead of each re-implementing
// the "fetch agent → 404 if missing → 403 if not manageable" sequence inline —
// a drifted copy of that sequence is exactly the latent authz bug this
// consolidation exists to prevent.
describe("requireManageableAgent", () => {
  function mockAgentRow(row: unknown) {
    const where = vi.fn().mockResolvedValue(row ? [row] : []);
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValue({ from } as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:true with the loaded agent when the actor may manage it", async () => {
    mockAgentRow({ id: "agent-1", name: "Smithers", isPersonal: true, ownerId: OWNER });

    const result = await requireManageableAgent("agent-1", { id: OWNER, role: "member" });

    expect(result).toEqual({
      ok: true,
      agent: { id: "agent-1", name: "Smithers", isPersonal: true, ownerId: OWNER },
    });
  });

  it("returns a 404 response when no agent matches the id", async () => {
    mockAgentRow(undefined);

    const result = await requireManageableAgent("ghost", { id: OWNER, role: "member" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(404);
    expect(await result.response.json()).toEqual({ error: "Agent not found" });
  });

  it("returns a 403 response with the default message when the actor may not manage the agent", async () => {
    mockAgentRow({ id: "agent-1", name: "Smithers", isPersonal: false, ownerId: null });

    const result = await requireManageableAgent("agent-1", { id: OTHER, role: "member" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: "You do not have access to this agent" });
  });

  it("uses the caller-supplied denied message instead of the default", async () => {
    mockAgentRow({ id: "agent-1", name: "Smithers", isPersonal: false, ownerId: null });

    const result = await requireManageableAgent(
      "agent-1",
      { id: OTHER, role: "member" },
      "You do not have permission to create a workflow on this agent"
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({
      error: "You do not have permission to create a workflow on this agent",
    });
  });

  it("allows an admin to manage a shared agent", async () => {
    mockAgentRow({ id: "agent-1", name: "Ops Bot", isPersonal: false, ownerId: null });

    const result = await requireManageableAgent("agent-1", { id: "user-admin", role: "admin" });

    expect(result.ok).toBe(true);
  });
});
