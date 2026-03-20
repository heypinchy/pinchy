import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts } from "@/db/schema";
import { hashPassword } from "better-auth/crypto";

function generatePassword(length = 16): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

export async function resetAdminPassword(
  email?: string
): Promise<{ email: string; password: string }> {
  // Find the admin user
  let adminUser: { id: string; email: string; role: string } | undefined;

  if (email) {
    const rows = await db.select().from(users).where(eq(users.email, email));
    adminUser = rows[0] as typeof adminUser;

    if (!adminUser) {
      throw new Error(`No user found with email: ${email}`);
    }
  } else {
    const rows = await db.select().from(users).where(eq(users.role, "admin"));
    adminUser = rows[0] as typeof adminUser;

    if (!adminUser) {
      throw new Error("No admin user found");
    }
  }

  // Generate and hash new password
  const newPassword = generatePassword();
  const hashedPassword = await hashPassword(newPassword);

  // Update the account table (Better Auth stores passwords there)
  await db
    .update(accounts)
    .set({ password: hashedPassword })
    .where(and(eq(accounts.userId, adminUser.id), eq(accounts.providerId, "credential")));

  return { email: adminUser.email, password: newPassword };
}
