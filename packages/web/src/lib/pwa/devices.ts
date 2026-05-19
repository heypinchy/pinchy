/**
 * Apple devices targeted by PWA splash-screen support.
 *
 * Logical dimensions are CSS pixels (used in media queries).
 * Physical dimensions are PNG dimensions (logical × pixelRatio).
 *
 * Sources for current values:
 * - https://www.ios-resolution.com/
 * - https://developer.apple.com/design/human-interface-guidelines/foundations/layout
 *
 * To add a new device:
 *   1. Append an entry below.
 *   2. Run `pnpm -C packages/web generate-pwa-assets`.
 *   3. Commit the generated PNGs.
 *   4. The drift-guard test enforces (1)+(3) stay in sync.
 */
export type AppleDevice = {
  slug: string; // filename-safe id; used as `public/splash/<slug>-{portrait,landscape}.png`
  family: "iphone" | "ipad";
  logicalWidth: number;
  logicalHeight: number;
  physicalWidth: number;
  physicalHeight: number;
  pixelRatio: 2 | 3;
};

export const DEVICES: readonly AppleDevice[] = [
  // iPhones — keep current top-3 form factors; old iPhones (X/11/12/13/14/15/16)
  // share the iPhone 17's 393×852 logical size, so a single asset covers them all.
  {
    slug: "iphone-17-pro-max",
    family: "iphone",
    logicalWidth: 440,
    logicalHeight: 956,
    physicalWidth: 1320,
    physicalHeight: 2868,
    pixelRatio: 3,
  },
  {
    slug: "iphone-17-pro",
    family: "iphone",
    logicalWidth: 402,
    logicalHeight: 874,
    physicalWidth: 1206,
    physicalHeight: 2622,
    pixelRatio: 3,
  },
  {
    slug: "iphone-17",
    family: "iphone",
    logicalWidth: 393,
    logicalHeight: 852,
    physicalWidth: 1179,
    physicalHeight: 2556,
    pixelRatio: 3,
  },
  // iPads — Pro 11" covers the common iPad Air 11" too.
  {
    slug: "ipad-pro-11",
    family: "ipad",
    logicalWidth: 834,
    logicalHeight: 1194,
    physicalWidth: 1668,
    physicalHeight: 2388,
    pixelRatio: 2,
  },
] as const;
