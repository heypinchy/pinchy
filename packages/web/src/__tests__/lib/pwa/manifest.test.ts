import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";

const PUBLIC_DIR = resolve(__dirname, "../../../../public");
const MANIFEST_PATH = join(PUBLIC_DIR, "manifest.webmanifest");

describe("manifest.webmanifest", () => {
  const raw = readFileSync(MANIFEST_PATH, "utf-8");
  const manifest = JSON.parse(raw) as Record<string, unknown>;

  it("declares Pinchy with required PWA fields", () => {
    expect(manifest.name).toBe("Pinchy");
    expect(manifest.short_name).toBe("Pinchy");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("declares both 'any' and 'maskable' icons", () => {
    const icons = manifest.icons as Array<{ src: string; purpose?: string }>;
    expect(icons.some((i) => i.purpose === "any" || !i.purpose)).toBe(true);
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("every referenced icon file exists in public/", () => {
    const icons = manifest.icons as Array<{ src: string }>;
    for (const icon of icons) {
      const path = join(PUBLIC_DIR, icon.src.replace(/^\//, ""));
      expect(existsSync(path), `icon missing: ${icon.src}`).toBe(true);
    }
  });
});
