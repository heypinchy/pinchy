import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * WCAG AA contrast invariants for the design tokens in globals.css.
 *
 * These mirror the design system's published "Contrast invariants" contract
 * (orange = ease/brand · teal = governance · green = success · amber = warning).
 * The point of the guard: nobody can reintroduce low-contrast foreground/
 * background pairings (e.g. white-on-orange, or orange text on white) without
 * this test going red. The numbers are derived, not hard-coded — we parse the
 * real OKLCH token values and compute WCAG contrast from them.
 */

const GLOBALS_CSS = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf8");

const AA_NORMAL = 4.5;

// --- OKLCH -> linear sRGB -> WCAG relative luminance -------------------------

function oklchToLinearSrgb(L: number, C: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [r, g, bb].map((v) => Math.min(1, Math.max(0, v))) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(c1: [number, number, number], c2: [number, number, number]): number {
  const l1 = relativeLuminance(oklchToLinearSrgb(...c1));
  const l2 = relativeLuminance(oklchToLinearSrgb(...c2));
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// --- token parsing -----------------------------------------------------------
// Only static (literal) regexes here. Building a RegExp from interpolated token
// names trips security/detect-non-literal-regexp and CodeQL js/incomplete-
// sanitization; a Map keyed by token name keeps lookups off object-injection
// sinks too.

const BLOCKS = [
  { selector: ":root", re: /:root\s*\{([^}]*)\}/ },
  { selector: ".dark", re: /\.dark\s*\{([^}]*)\}/ },
] as const;
const OKLCH_TOKEN_RE = /--([\w-]+):\s*oklch\(([^)]+)\)/g;

type Lch = [number, number, number];

/** Parse all `--token: oklch(L C H);` declarations of a block into a Map. */
function tokensIn(blockRe: RegExp, selector: string): Map<string, Lch> {
  const match = GLOBALS_CSS.match(blockRe);
  if (!match) throw new Error(`Could not find "${selector}" block in globals.css`);
  const tokens = new Map<string, Lch>();
  for (const [, name, value] of match[1].matchAll(OKLCH_TOKEN_RE)) {
    const [L, C, H] = value
      .split("/")[0] // drop any "/ alpha"
      .trim()
      .split(/\s+/)
      .map(Number);
    tokens.set(name, [L, C, H]);
  }
  return tokens;
}

function token(tokens: Map<string, Lch>, name: string): Lch {
  const value = tokens.get(name);
  if (!value) throw new Error(`Token --${name} not found / not an oklch() value`);
  return value;
}

describe("design token contrast invariants (globals.css)", () => {
  for (const { selector, re } of BLOCKS) {
    describe(selector, () => {
      it("primary-foreground on primary meets WCAG AA (button/badge text on orange)", () => {
        const tokens = tokensIn(re, selector);
        const fg = token(tokens, "primary-foreground");
        const bg = token(tokens, "primary");
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
      });

      it("destructive-foreground on destructive meets WCAG AA (! badge on error red)", () => {
        const tokens = tokensIn(re, selector);
        const fg = token(tokens, "destructive-foreground");
        const bg = token(tokens, "destructive");
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
      });

      // Orange link/body text + the radio-group indicator sit on these solid
      // surfaces. (Tinted backgrounds like bg-primary/10 only nudge the surface
      // toward orange — they keep more headroom than the solid case, so the
      // solid surfaces are the binding constraint.)
      for (const surface of ["background", "card", "popover"]) {
        it(`primary-accent on ${surface} meets WCAG AA (orange link/body/indicator)`, () => {
          const tokens = tokensIn(re, selector);
          const fg = token(tokens, "primary-accent");
          const bg = token(tokens, surface);
          expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    });
  }
});
