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

export async function createAdmin(name: string, email: string, password: string) {
  const passwordHash = await bcrypt.hash(password, 12);

  return await db.transaction(async (tx) => {
    const existing = await tx.query.users.findFirst();
    if (existing) {
      throw new Error("Setup already complete");
    }

    const [user] = await tx
      .insert(users)
      .values({
        name,
        email,
        passwordHash,
        role: "admin",
      })
      .returning();

    await seedDefaultAgent(user.id);

    return { id: user.id, email: user.email };
  });
}
