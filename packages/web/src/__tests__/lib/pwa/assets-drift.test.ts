/**
 * Drift guard: every entry in DEVICES must have matching splash PNGs.
 * If you add a device to DEVICES without running the generator, this fails.
 *
 * Regenerate with: `pnpm -C packages/web generate-pwa-assets`
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { DEVICES } from "@/lib/pwa/devices";

const PUBLIC_DIR = resolve(__dirname, "../../../../public");

describe("PWA assets drift guard", () => {
  it.each(DEVICES)("$slug has portrait + landscape PNGs", (device) => {
    const portrait = join(PUBLIC_DIR, "splash", `${device.slug}-portrait.png`);
    const landscape = join(PUBLIC_DIR, "splash", `${device.slug}-landscape.png`);
    expect(existsSync(portrait), `missing: ${portrait}`).toBe(true);
    expect(existsSync(landscape), `missing: ${landscape}`).toBe(true);
  });

  it("maskable icon exists", () => {
    expect(existsSync(join(PUBLIC_DIR, "icon-maskable-512.png"))).toBe(true);
  });

  it("DEVICES is non-empty", () => {
    expect(DEVICES.length).toBeGreaterThan(0);
  });

  it("public/splash contains no orphaned PNGs", () => {
    const expected = new Set(
      DEVICES.flatMap((d) => [`${d.slug}-portrait.png`, `${d.slug}-landscape.png`])
    );
    const actual = readdirSync(join(PUBLIC_DIR, "splash")).filter((f) => f.endsWith(".png"));
    const orphans = actual.filter((f) => !expected.has(f));
    expect(orphans, `orphaned splash assets: ${orphans.join(", ")}`).toEqual([]);
  });
});
