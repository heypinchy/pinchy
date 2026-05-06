import { db } from "@/db";
import { createSmithersAgent } from "@/lib/personal-agent";
import { getSetting } from "@/lib/settings";
import { PROVIDERS, type ProviderName } from "@/lib/providers";

export async function seedDefaultAgent(ownerId?: string) {
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
    ownerId: ownerId ?? null,
    isPersonal: ownerId ? true : false,
    isAdmin: ownerId ? true : false,
  });
}
