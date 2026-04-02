import { db } from "../src/db";
import { settings } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  const existing = await db.query.settings.findFirst({
    where: eq(settings.key, "domain"),
  });

  if (!existing) {
    console.log("No domain lock is configured. Nothing to reset.");
    process.exit(0);
  }

  await db.delete(settings).where(eq(settings.key, "domain"));
  console.log(`Domain lock removed (was: ${existing.value}).`);
  console.log("Pinchy is now accessible via any host. Restart the container to apply.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to reset domain:", err.message);
  process.exit(1);
});
