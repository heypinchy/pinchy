import type { UserRole, InviteRole } from "@/db/enums";

export interface UserGroup {
  id: string;
  name: string;
}

export type UserListItem =
  | {
      kind: "user";
      id: string;
      name: string;
      email: string;
      role: UserRole;
      status: "active" | "deactivated";
      groups: UserGroup[];
    }
  | {
      kind: "invite";
      id: string;
      email: string | null;
      role: InviteRole;
      status: "pending" | "expired";
      createdAt: string;
      groups: UserGroup[];
    };

// The role columns are constrained by a database CHECK derived from the same
// consts (db/enums.ts), and schema-hardening.integration.test.ts reads that
// constraint back from Postgres — so narrowing the response type here is a
// guarantee the server actually holds, not an assumption.
interface ApiUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  banned: boolean;
  groups?: UserGroup[];
}

interface ApiInvite {
  id: string;
  email: string | null;
  role: InviteRole;
  type: string;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  groups?: UserGroup[];
}

const STATUS_ORDER: Record<UserListItem["status"], number> = {
  active: 0,
  pending: 1,
  expired: 2,
  deactivated: 3,
};

export function mergeUserList(
  users: ApiUser[],
  invites: ApiInvite[],
  now: Date = new Date()
): UserListItem[] {
  const userItems: UserListItem[] = users.map((u) => ({
    kind: "user",
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.banned ? "deactivated" : "active",
    groups: u.groups || [],
  }));

  const inviteItems: UserListItem[] = invites
    .filter((inv) => inv.type === "invite" && inv.claimedAt === null)
    .map((inv) => ({
      kind: "invite",
      id: inv.id,
      email: inv.email,
      role: inv.role,
      status: new Date(inv.expiresAt) > now ? "pending" : "expired",
      createdAt: inv.createdAt,
      groups: inv.groups || [],
    }));

  return [...userItems, ...inviteItems].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  );
}
