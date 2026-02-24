import { createAvatar } from "@dicebear/core";
import * as botttsNeutral from "@dicebear/bottts-neutral";

const SMITHERS_AVATAR_PATH = "/images/smithers-avatar.png";

export function getAgentAvatarSvg(agent: { avatarSeed: string | null; name: string }): string {
  const seed = agent.avatarSeed ?? agent.name;

  if (seed === "__smithers__") {
    return SMITHERS_AVATAR_PATH;
  }

  const avatar = createAvatar(botttsNeutral, { seed, size: 64 });
  return avatar.toDataUri();
}

export function generateAvatarSeed(): string {
  return crypto.randomUUID();
}
