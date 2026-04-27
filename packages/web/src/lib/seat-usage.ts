import { and, count, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { users, invites } from "@/db/schema";
import type { LicenseStatus } from "@/lib/license";

export interface SeatUsage {
  used: number;
  max: number;
  available: number | null;
  unlimited: boolean;
  activeUsers: number;
  pendingInvites: number;
}

export async function getSeatUsage(license: LicenseStatus): Promise<SeatUsage> {
  const [activeRows, pendingRows] = await Promise.all([
    db
      .select({ count: count() })
      .from(users)
      .where(or(eq(users.banned, false), isNull(users.banned))),
    db
      .select({ count: count() })
      .from(invites)
      .where(and(isNull(invites.claimedAt), gt(invites.expiresAt, new Date()))),
  ]);
  const activeUsers = activeRows[0].count;
  const pendingInvites = pendingRows[0].count;
  const used = activeUsers + pendingInvites;
  const max = license.maxUsers;
  return {
    used,
    max,
    available: max === 0 ? null : Math.max(0, max - used),
    unlimited: max === 0,
    activeUsers,
    pendingInvites,
  };
}
