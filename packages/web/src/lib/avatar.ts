import { createAvatar } from "@dicebear/core";
import * as notionists from "@dicebear/notionists";
import { uuid } from "@/lib/uuid";

const SMITHERS_AVATAR_PATH = "/images/smithers-avatar.png";

// Warm-led brand palette with a few accents for variety. Each entry pairs a
// solid background with a light "skin" tint of the same hue. The notionists
// faces are black-and-white line art with white fills, so we recolor those
// white fills to the skin tint — a duotone that lets the colour read through
// the face instead of leaving it plain black-and-white.
export const PALETTE = [
  { bg: "ef4444", skin: "f8cfc7" }, // red
  { bg: "f97316", skin: "fbdcbb" }, // orange
  { bg: "c2410c", skin: "e9bda7" }, // terracotta
  { bg: "d9486a", skin: "f3c4d0" }, // rose
  { bg: "e0991f", skin: "f4e0ad" }, // amber
  { bg: "b23a48", skin: "e6bfc4" }, // deep red
  { bg: "2bb3a3", skin: "c2e7e1" }, // teal
  { bg: "3b82c4", skin: "c8dcef" }, // blue
  { bg: "5aa84f", skin: "d2e7cd" }, // green
  { bg: "9b7ede", skin: "ded3f3" }, // violet
] as const;

export const BACKGROUND_COLORS = PALETTE.map((p) => p.bg);

// bg hex -> matching light skin tint, so the tint step can reuse the background
// the seed already landed on instead of hashing a second time.
const SKIN_BY_BG = new Map(PALETTE.map((p) => [p.bg, p.skin]));

// Deterministically pick a palette entry from the seed, so the chosen
// background and its matching skin tint are known to us (DiceBear's own random
// pick wouldn't tell us which colour it landed on).
function pickPalette(seed: string): (typeof PALETTE)[number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

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
    scale: 180,
    translateY: 14,
    radius: 50,
    backgroundColor: [pickPalette(seed).bg],
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

  // buildNotionistsOptions already ran pickPalette to choose the background;
  // reuse that choice for the matching skin tint instead of hashing twice.
  const options = buildNotionistsOptions(seed, agent.name);
  const skin = SKIN_BY_BG.get(options.backgroundColor[0]) ?? PALETTE[0].skin;
  const svg = createAvatar(notionists, options).toString();
  // notionists faces are b/w line art with white fills; tint those whites to a
  // light shade of the background hue so the face carries colour.
  const tinted = svg.replace(/#ffffff/gi, `#${skin}`).replace(/#fff\b/gi, `#${skin}`);
  return `data:image/svg+xml,${encodeURIComponent(tinted)}`;
}

export function generateAvatarSeed(): string {
  return uuid();
}
