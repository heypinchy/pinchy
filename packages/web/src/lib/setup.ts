import bcrypt from "bcryptjs";
import { db } from "@/db";
import { users } from "@/db/schema";
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

export async function createAdmin(email: string, password: string) {
  const existing = await db.query.users.findFirst();
  if (existing) {
    throw new Error("Setup already complete");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      role: "admin",
    })
    .returning();

  // Seed default agent
  await seedDefaultAgent();

  return { id: user.id, email: user.email };
}
