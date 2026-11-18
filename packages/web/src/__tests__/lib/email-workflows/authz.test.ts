// Unit tests for the workflow scope gate (design §7, #705) — the single source
// of truth every workflow route (create / list / enable-disable / delete)
// shares. The route integration tests exercise the wiring (own-personal allow,
// shared forbid); this pins the full RBAC matrix at the one place the rule
// lives, so the load-bearing `ownerId === actor.id` term can't silently drop
// out. In particular a member acting on *someone else's* personal agent — the
// branch the route suites don't cover — must be forbidden.
import { describe, it, expect } from "vitest";

import { canManageAgentWorkflows } from "@/lib/email-workflows/authz";

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
