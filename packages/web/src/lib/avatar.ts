import { createAvatar } from "@dicebear/core";
import * as notionists from "@dicebear/notionists";
import { uuid } from "@/lib/uuid";

const SMITHERS_AVATAR_PATH = "/images/smithers-avatar.png";

// Warm Pinchy brand ramp. DiceBear picks one deterministically from the seed,
// so every agent's background stays on-brand.
export const BACKGROUND_COLORS = [
  "ef4444", // red (primary)
  "f97316", // orange (primary)
  "c2410c", // burnt orange
  "b23a48", // deep rose
  "9e4b2a", // terracotta
  "dc4634", // warm red
];

// Curated notionists hairstyles. We deliberately exclude culturally specific
// headwear (turban/headscarf: variant61-63) and props (hat, headphones:
// variant08) so the agent roster stays neutral and professional. Masculine and
// feminine sets are disjoint so we can pin a presentation by name; the mixed
// pool is the default for codenames and user-created agents.
const HAIR_MASCULINE = [
  "variant01",
  "variant02",
  "variant03",
  "variant06",
  "variant09",
  "variant10",
  "variant12",
  "variant15",
  "variant16",
  "variant18",
  "variant20",
  "variant24",
  "variant26",
  "variant33",
  "variant44",
  "variant54",
  "variant55",
  "variant60",
] as const;
const HAIR_FEMININE = [
  "variant27",
  "variant28",
  "variant32",
  "variant35",
  "variant36",
  "variant38",
  "variant39",
  "variant41",
  "variant46",
  "variant48",
  "variant49",
  "variant57",
  "variant58",
] as const;
const HAIR_MIXED = [...HAIR_MASCULINE, ...HAIR_FEMININE];

export { HAIR_MASCULINE, HAIR_FEMININE, HAIR_MIXED };

type HairVariant = (typeof HAIR_MASCULINE)[number] | (typeof HAIR_FEMININE)[number];

// Calm, professional facial features (curated subset of the available variants).
const BROWS = ["variant01", "variant03", "variant05", "variant07", "variant09"] as const;
const LIPS = [
  "variant01",
  "variant02",
  "variant05",
  "variant08",
  "variant19",
  "variant24",
] as const;
const NOSE = ["variant02", "variant05", "variant08", "variant14"] as const;

export type Presentation = "feminine" | "masculine" | "mixed";

// Explicit, curated allow-list of clearly-gendered agent names we ship or
// expect. We never *infer* gender from an arbitrary user-provided name —
// anything not in this map falls back to the mixed pool. Extend deliberately.
const GENDER_BY_NAME = new Map<string, Presentation>([
  ["ada", "feminine"],
  ["maya", "feminine"],
  ["sherlock", "masculine"],
]);

export function resolvePresentation(name: string): Presentation {
  return GENDER_BY_NAME.get(name.trim().toLowerCase()) ?? "mixed";
}

function hairFor(presentation: Presentation): readonly HairVariant[] {
  if (presentation === "feminine") return HAIR_FEMININE;
  if (presentation === "masculine") return HAIR_MASCULINE;
  return HAIR_MIXED;
}

function beardProbabilityFor(presentation: Presentation): number {
  if (presentation === "feminine") return 0;
  if (presentation === "masculine") return 35;
  return 15;
}

export function buildNotionistsOptions(seed: string, name: string) {
  const presentation = resolvePresentation(name);
  return {
    seed,
    size: 64,
    // Head-focused framing: zoom in and nudge down so the face fills the circle
    // instead of wasting space on the torso. Fine-tune these two values here.
    scale: 150,
    translateY: 16,
    radius: 50,
    backgroundColor: [...BACKGROUND_COLORS],
    brows: [...BROWS],
    lips: [...LIPS],
    nose: [...NOSE],
    glassesProbability: 14,
    gestureProbability: 0,
    bodyIconProbability: 0,
    beardProbability: beardProbabilityFor(presentation),
    hair: [...hairFor(presentation)],
  };
}

export function getAgentAvatarSvg(agent: { avatarSeed: string | null; name: string }): string {
  const seed = agent.avatarSeed ?? agent.name;

  if (seed === "__smithers__") {
    return SMITHERS_AVATAR_PATH;
  }

  const avatar = createAvatar(notionists, buildNotionistsOptions(seed, agent.name));
  return avatar.toDataUri();
}

export function generateAvatarSeed(): string {
  return uuid();
}
