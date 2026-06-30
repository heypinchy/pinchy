import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getSettingsByPrefix } from "@/lib/settings";
import { getVisibleAgents } from "@/lib/visible-agents";
import { getOrgPairingSmithers, type PairingCandidate } from "@/lib/pairing-candidates";

export const GET = withAuth(async (_req, _ctx, session) => {
  const visibleAgents = await getVisibleAgents(session.user.id!, session.user.role ?? "member");
  const visibleIds = new Set(visibleAgents.map((a) => a.id));
  const orgPairing = await getOrgPairingSmithers(visibleIds);

  const candidates: PairingCandidate[] = [
    ...visibleAgents.map((a) => ({
      realId: a.id,
      publicId: a.id,
      publicName: a.name,
      isPersonal: a.isPersonal,
    })),
    ...orgPairing,
  ];

  // Batched: one `telegram_bot_username:` prefix query instead of a
  // `getSetting` round-trip per candidate (#261 N+1).
  const botUsernameByKey = await getSettingsByPrefix("telegram_bot_username:");

  const bots = candidates.flatMap((candidate) => {
    const botUsername = botUsernameByKey.get(`telegram_bot_username:${candidate.realId}`);
    return botUsername
      ? [
          {
            agentId: candidate.publicId,
            agentName: candidate.publicName,
            botUsername,
            isPersonal: candidate.isPersonal,
          },
        ]
      : [];
  });

  // Sort personal agents (Smithers) first — the pairing UI uses bots[0] as
  // the primary bot for the QR code. Users should always pair via Smithers
  // (the shared entry point), not via a restricted agent's bot.
  bots.sort((a, b) => (a.isPersonal === b.isPersonal ? 0 : a.isPersonal ? -1 : 1));

  return NextResponse.json({ bots });
});
