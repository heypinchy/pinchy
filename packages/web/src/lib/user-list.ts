export type UserListItem =
  | {
      kind: "user";
      id: string;
      name: string;
      email: string;
      role: string;
      status: "active" | "deactivated";
    }
  | {
      kind: "invite";
      id: string;
      email: string | null;
      role: string;
      status: "pending" | "expired";
      createdAt: string;
    };

interface ApiUser {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
}

interface ApiInvite {
  id: string;
  email: string | null;
  role: string;
  type: string;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
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
    }));

  return [...userItems, ...inviteItems].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  );
}
