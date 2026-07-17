// @vitest-environment node
import { describe, it, expect } from "vitest";
import { checkPermission, getPermittedOperations, type Permissions } from "../permissions";

describe("checkPermission", () => {
  const permissions: Permissions = { email: ["read", "draft"] };

  it("returns true for allowed operation", () => {
    expect(checkPermission(permissions, "email", "read")).toBe(true);
    expect(checkPermission(permissions, "email", "draft")).toBe(true);
  });

  it("returns false for denied operation", () => {
    expect(checkPermission(permissions, "email", "send")).toBe(false);
  });

  it("returns false for unknown model", () => {
    expect(checkPermission(permissions, "calendar", "read")).toBe(false);
  });

  it("returns false for empty permissions", () => {
    expect(checkPermission({}, "email", "read")).toBe(false);
  });

  // MIGRATION TEST (AGENTS.md § "Test Migrations Against Pre-Existing Data"):
  // pre-#328 agent template creation could persist a standalone (email,
  // "search") permission row with NO accompanying "read" row (see
  // packages/web/src/lib/tool-registry.ts EMAIL_OPERATIONS comment for the
  // write-path history). build.ts passes the raw DB operations straight
  // through into the plugin config's `permissions` object — it does not
  // rewrite stored rows — so the plugin itself must tolerate this legacy
  // shape at the permission check, not just the web-side tools derivation.
  // Without this, every email_list/email_read/email_search/
  // email_get_attachment call is denied at runtime for a stale config that
  // was never regenerated after upgrading to #328.
  describe("legacy 'search' operation (pre-#328 rows without a 'read' row)", () => {
    it("grants the 'read' check when only a legacy 'search' operation is present", () => {
      const legacyPermissions: Permissions = { email: ["search"] };
      expect(checkPermission(legacyPermissions, "email", "read")).toBe(true);
    });

    it("does NOT grant 'draft' from a legacy 'search'-only grant", () => {
      const legacyPermissions: Permissions = { email: ["search"] };
      expect(checkPermission(legacyPermissions, "email", "draft")).toBe(false);
    });

    it("does NOT grant 'send' from a legacy 'search'-only grant", () => {
      const legacyPermissions: Permissions = { email: ["search"] };
      expect(checkPermission(legacyPermissions, "email", "send")).toBe(false);
    });

    it("does not itself answer true for a 'search' operation check unless explicitly granted", () => {
      // checkPermission is never called with operation="search" by index.ts
      // (there is no email_search-specific gate — it shares the "read"
      // gate), but pin the literal behavior anyway: "search" is only an
      // alias INTO "read", not a general wildcard.
      const readOnlyPermissions: Permissions = { email: ["read"] };
      expect(checkPermission(readOnlyPermissions, "email", "search")).toBe(false);
    });
  });

  // MIGRATION TEST (AGENTS.md § "Test Migrations Against Pre-Existing Data"):
  // "list" is the OTHER legacy per-tool operation pre-#328 template creation
  // could persist (alongside "search" above), and unlike "search" it had NO
  // alias at all until now — a standalone (email, "list") row denied every
  // read check, silently losing every email tool for that agent after
  // upgrading, the exact failure mode the "search" alias was meant to
  // prevent. Treat a granted "list" operation as satisfying a "read" check
  // for the same reason as "search": it must NOT make "list" satisfy "draft"
  // or "send".
  describe("legacy 'list' operation (pre-#328 rows without a 'read' row)", () => {
    it("grants the 'read' check when only a legacy 'list' operation is present", () => {
      const legacyPermissions: Permissions = { email: ["list"] };
      expect(checkPermission(legacyPermissions, "email", "read")).toBe(true);
    });

    it("does NOT grant 'draft' from a legacy 'list'-only grant", () => {
      const legacyPermissions: Permissions = { email: ["list"] };
      expect(checkPermission(legacyPermissions, "email", "draft")).toBe(false);
    });

    it("does NOT grant 'send' from a legacy 'list'-only grant", () => {
      const legacyPermissions: Permissions = { email: ["list"] };
      expect(checkPermission(legacyPermissions, "email", "send")).toBe(false);
    });

    it("does not itself answer true for a 'list' operation check unless explicitly granted", () => {
      const readOnlyPermissions: Permissions = { email: ["read"] };
      expect(checkPermission(readOnlyPermissions, "email", "list")).toBe(false);
    });
  });
});

describe("getPermittedOperations", () => {
  it("returns operations for a model", () => {
    const permissions: Permissions = { email: ["read", "draft", "send"] };
    expect(getPermittedOperations(permissions, "email")).toEqual(["read", "draft", "send"]);
  });

  it("returns empty array for unknown model", () => {
    expect(getPermittedOperations({}, "email")).toEqual([]);
  });
});
