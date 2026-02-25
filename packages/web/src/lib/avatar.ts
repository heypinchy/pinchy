import { createAvatar } from "@dicebear/core";
import * as funEmoji from "@dicebear/fun-emoji";

const SMITHERS_AVATAR_PATH = "/images/smithers-avatar.png";

// Warm, bright Pinchy color palette for avatar backgrounds
const BACKGROUND_COLORS = [
  "FFEAA7", // warm yellow
  "FFC3A0", // soft coral
  "F8B4B4", // gentle pink
  "B4E4C8", // soft green
  "A8D8EA", // light blue
  "D4A5E5", // soft lavender
  "FFD6A5", // peach
];

// Only friendly/positive expressions
const HAPPY_EYES = [
  "cute",
  "wink",
  "wink2",
  "plain",
  "stars",
  "love",
  "glasses",
  "shades",
] as const;
const HAPPY_MOUTHS = [
  "lilSmile",
  "cute",
  "wideSmile",
  "smileTeeth",
  "smileLol",
  "kissHeart",
  "shy",
] as const;

export function getAgentAvatarSvg(agent: { avatarSeed: string | null; name: string }): string {
  const seed = agent.avatarSeed ?? agent.name;

  if (seed === "__smithers__") {
    return SMITHERS_AVATAR_PATH;
  }

  const avatar = createAvatar(funEmoji, {
    seed,
    size: 64,
    backgroundColor: BACKGROUND_COLORS,
    eyes: [...HAPPY_EYES],
    mouth: [...HAPPY_MOUTHS],
  });
  return avatar.toDataUri();
}

export function generateAvatarSeed(): string {
  return crypto.randomUUID();
}
