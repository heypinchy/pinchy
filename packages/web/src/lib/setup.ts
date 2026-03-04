import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { seedDefaultAgent } from "@/db/seed";
import { getSetting } from "@/lib/settings";

export async function isProviderConfigured(): Promise<boolean> {
  const provider = await getSetting("default_provider");
  return provider !== null;
}

export async function isSetupComplete(): Promise<boolean> {
  const firstUser = await db.query.users.findFirst();
  return firstUser !== undefined;
}

export async function createAdmin(name: string, email: string, password: string) {
  const existing = await db.query.users.findFirst();
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

  // Set admin role directly in DB
  await db.update(users).set({ role: "admin" }).where(eq(users.id, result.user.id));

  await seedDefaultAgent(result.user.id);

  return { id: result.user.id, email: result.user.email };
}
