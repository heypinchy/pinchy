import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { eq, and } from "drizzle-orm";

// Anonymized identity used for the org-wide Telegram pairing entry point when
// the underlying agent (the admin's personal Smithers) is not RBAC-visible to
// the requesting user. The bot username itself is public via BotFather, but
// the agent's real id and any custom rename must not leak across users.
export const PAIRING_PUBLIC_AGENT_ID = "pinchy-pairing-bot";
export const PAIRING_PUBLIC_AGENT_NAME = "Smithers";

export interface PairingCandidate {
  realId: string;
  publicId: string;
  publicName: string;
  isPersonal: boolean;
}

/**
 * Returns the org-wide Telegram pairing bot(s) that should be exposed to a user
 * even when their RBAC view (`getVisibleAgents`) excludes the underlying agent.
 *
 * Pinchy's setup wizard creates Smithers as `isPersonal: true, ownerId: <admin>`
 * and the admin connects the org's Telegram bot to it. Without this fallback,
 * non-admin members would see an empty pairing UI even though Telegram is
 * configured org-wide. We expose only one anonymized candidate (the oldest
 * Smithers personal-agent) to keep the pairing flow working without leaking
 * which admin owns it or any custom agent name.
 */
export async function getOrgPairingSmithers(
  alreadyVisibleAgentIds: Set<string>
): Promise<PairingCandidate[]> {
  const allOrgSmithers = await db
    .select()
    .from(activeAgents)
    .where(and(eq(activeAgents.avatarSeed, "__smithers__"), eq(activeAgents.isPersonal, true)));

  const candidates = allOrgSmithers
    .filter((a) => !alreadyVisibleAgentIds.has(a.id))
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    .slice(0, 1);

  return candidates.map((a) => ({
    realId: a.id,
    publicId: PAIRING_PUBLIC_AGENT_ID,
    publicName: PAIRING_PUBLIC_AGENT_NAME,
    isPersonal: true,
  }));
}
