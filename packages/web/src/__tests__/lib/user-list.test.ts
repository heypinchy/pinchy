import { describe, it, expect } from "vitest";
import { mergeUserList, type UserListItem } from "@/lib/user-list";

describe("mergeUserList", () => {
  const now = new Date("2026-03-06T12:00:00Z");

  it("maps registered users to active status", () => {
    const result = mergeUserList(
      [{ id: "u1", name: "Alice", email: "alice@test.com", role: "member", banned: false }],
      [],
      now
    );
    expect(result).toEqual([
      {
        kind: "user",
        id: "u1",
        name: "Alice",
        email: "alice@test.com",
        role: "member",
        status: "active",
        groups: [],
      },
    ]);
  });

  it("maps banned users to deactivated status", () => {
    const result = mergeUserList(
      [{ id: "u1", name: "Alice", email: "alice@test.com", role: "member", banned: true }],
      [],
      now
    );
    expect(result[0].status).toBe("deactivated");
  });

  it("maps unclaimed unexpired invites to pending", () => {
    const result = mergeUserList(
      [],
      [
        {
          id: "inv1",
          email: "bob@test.com",
          role: "member",
          type: "invite",
          createdAt: "2026-03-05T00:00:00Z",
          expiresAt: "2026-03-12T00:00:00Z",
          claimedAt: null,
        },
      ],
      now
    );
    expect(result).toEqual([
      {
        kind: "invite",
        id: "inv1",
        email: "bob@test.com",
        role: "member",
        status: "pending",
        createdAt: "2026-03-05T00:00:00Z",
        groups: [],
      },
    ]);
  });

  it("maps unclaimed expired invites to expired", () => {
    const result = mergeUserList(
      [],
      [
        {
          id: "inv1",
          email: "bob@test.com",
          role: "member",
          type: "invite",
          createdAt: "2026-02-01T00:00:00Z",
          expiresAt: "2026-02-08T00:00:00Z",
          claimedAt: null,
        },
      ],
      now
    );
    expect(result[0].status).toBe("expired");
  });

  it("excludes claimed invites", () => {
    const result = mergeUserList(
      [],
      [
        {
          id: "inv1",
          email: "bob@test.com",
          role: "member",
          type: "invite",
          createdAt: "2026-03-01T00:00:00Z",
          expiresAt: "2026-03-08T00:00:00Z",
          claimedAt: "2026-03-02T00:00:00Z",
        },
      ],
      now
    );
    expect(result).toEqual([]);
  });

  it("excludes reset-type invites", () => {
    const result = mergeUserList(
      [],
      [
        {
          id: "inv1",
          email: "bob@test.com",
          role: "member",
          type: "reset",
          createdAt: "2026-03-01T00:00:00Z",
          expiresAt: "2026-03-08T00:00:00Z",
          claimedAt: null,
        },
      ],
      now
    );
    expect(result).toEqual([]);
  });

  it("sorts: active > pending > expired > deactivated", () => {
    const result = mergeUserList(
      [
        { id: "u1", name: "Active", email: "a@t.com", role: "member", banned: false },
        { id: "u2", name: "Banned", email: "b@t.com", role: "member", banned: true },
      ],
      [
        {
          id: "inv1",
          email: "p@t.com",
          role: "member",
          type: "invite",
          createdAt: "2026-03-05T00:00:00Z",
          expiresAt: "2026-03-12T00:00:00Z",
          claimedAt: null,
        },
        {
          id: "inv2",
          email: "e@t.com",
          role: "member",
          type: "invite",
          createdAt: "2026-02-01T00:00:00Z",
          expiresAt: "2026-02-08T00:00:00Z",
          claimedAt: null,
        },
      ],
      now
    );
    expect(result.map((r) => r.status)).toEqual(["active", "pending", "expired", "deactivated"]);
  });

  it("includes groups on invites when provided", () => {
    const result = mergeUserList(
      [],
      [
        {
          id: "inv1",
          email: "bob@test.com",
          role: "member",
          type: "invite",
          createdAt: "2026-03-05T00:00:00Z",
          expiresAt: "2026-03-12T00:00:00Z",
          claimedAt: null,
          groups: [{ id: "g1", name: "HR" }],
        },
      ],
      now
    );
    expect(result[0]).toMatchObject({
      kind: "invite",
      groups: [{ id: "g1", name: "HR" }],
    });
  });

  it("defaults invite groups to empty array when not provided", () => {
    const result = mergeUserList(
      [],
      [
        {
          id: "inv1",
          email: "bob@test.com",
          role: "member",
          type: "invite",
          createdAt: "2026-03-05T00:00:00Z",
          expiresAt: "2026-03-12T00:00:00Z",
          claimedAt: null,
        },
      ],
      now
    );
    expect(result[0]).toMatchObject({
      kind: "invite",
      groups: [],
    });
  });

  it("handles invites without email", () => {
    const result = mergeUserList(
      [],
      [
        {
          id: "inv1",
          email: null,
          role: "member",
          type: "invite",
          createdAt: "2026-03-05T00:00:00Z",
          expiresAt: "2026-03-12T00:00:00Z",
          claimedAt: null,
        },
      ],
      now
    );
    expect(result[0]).toMatchObject({ kind: "invite", email: null });
  });
});
