import { db } from "@/db";
import { createSmithersAgent } from "@/lib/personal-agent";
import { getSetting } from "@/lib/settings";
import { PROVIDERS, type ProviderName } from "@/lib/providers";

/**
 * Creates the admin's Smithers during the setup wizard. Called exactly once,
 * from `createAdmin` in lib/setup.ts, right after the admin row is inserted.
 *
 * `ownerId` is required on purpose. It used to be optional, and the resulting
 * `ownerId ?? null` branch produced an ownerless, non-personal, non-admin
 * Smithers — a shape no production path has ever created, because the only
 * caller passes `result.user.id` behind a `if (!result?.user) throw`. The
 * branch existed solely for tests, and it was convincing enough there to be
 * cited as real platform behavior during PR #754's review before the code was
 * checked. A parameter whose only reachable value comes from tests is a trap:
 * it documents a state the system cannot actually be in.
 *
 * Personal agents for non-admin users go through `seedPersonalAgent` instead,
 * which takes its own `isAdmin` flag.
 */
export async function seedDefaultAgent(ownerId: string) {
  const existing = await db.query.agents.findFirst();
  if (existing) return existing;

  // Use the configured default provider's static default model so Smithers
  // starts with a working model on first boot. Falls back to Anthropic Sonnet
  // when no provider is configured yet (cold start before setup wizard runs).
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;
  const model =
    (defaultProvider && PROVIDERS[defaultProvider]?.defaultModel) || "anthropic/claude-sonnet-4-6";

  return createSmithersAgent({
    model,
    ownerId,
    isPersonal: true,
    isAdmin: true,
  });
}
