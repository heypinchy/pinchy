import { db } from "@/db";

export async function isSetupComplete(): Promise<boolean> {
  const firstUser = await db.query.users.findFirst();
  return firstUser !== undefined;
}
