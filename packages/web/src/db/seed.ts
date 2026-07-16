import { db } from "@/db";
import { createSmithersAgent } from "@/lib/personal-agent";
import { getSetting } from "@/lib/settings";
import { PROVIDERS, type ProviderName } from "@/lib/providers";

/**
 * Creates the admin's Smithers during the setup wizard. Called exactly once,
 * from `createAdmin` in lib/setup.ts, right after the admin row is inserted.
 *
 * `ownerId` is required on purpose: the sole caller passes the freshly created
 * admin's id behind a `if (!result?.user) throw`, so an ownerless Smithers is a
 * state the platform cannot be in. Making the parameter optional again would
 * document one that it can — the earlier `ownerId ?? null` branch was reachable
 * from tests only, and got cited as real behavior during PR #754's review.
 *
 * Personal agents for non-admin users go through `seedPersonalAgent` instead,
 * which takes its own `isAdmin` flag.
 */
export async function seedAdminSmithers(ownerId: string) {
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
