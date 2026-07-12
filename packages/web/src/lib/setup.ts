import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { seedDefaultAgent } from "@/db/seed";
import { getSetting } from "@/lib/settings";
import { setOrgTimezone } from "@/lib/settings-timezone";

export async function isProviderConfigured(): Promise<boolean> {
  const provider = await getSetting("default_provider");
  return provider !== null;
}

export async function isSetupComplete(): Promise<boolean> {
  const adminUser = await db.query.users.findFirst({
    where: eq(users.role, "admin"),
  });
  return adminUser !== undefined;
}

export async function createAdmin(
  name: string,
  email: string,
  password: string,
  browserTimezone?: string
) {
  const existing = await db.query.users.findFirst({
    where: eq(users.role, "admin"),
  });
  if (existing) {
    throw new Error("Setup already complete");
  }

  // Create user via Better Auth (handles password hashing with scrypt)
  const result = await auth.api.signUpEmail({
    body: { name, email, password },
  });

  if (!result?.user) {
    throw new Error("Failed to create admin user");
  }

  try {
    // Set admin role directly in DB
    await db.update(users).set({ role: "admin" }).where(eq(users.id, result.user.id));

    await seedDefaultAgent(result.user.id);

    await setOrgTimezone(browserTimezone ?? "UTC");
  } catch (error) {
    // Clean up the orphaned user if post-signup steps fail
    try {
      await db.delete(users).where(eq(users.id, result.user.id));
    } catch {
      // Best effort cleanup
    }
    throw error;
  }

  return { id: result.user.id, email: result.user.email };
}
