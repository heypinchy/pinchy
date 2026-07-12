import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { ALLOWED_ATTACHMENT_MIMES, ALLOWED_TEXT_MIMES } from "@/lib/upload-validation";

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

  it("declares a share_target that POSTs shared files to /share-target", () => {
    const shareTarget = manifest.share_target as {
      action: string;
      method: string;
      enctype: string;
      params: { files: Array<{ name: string; accept: string[] }> };
    };
    expect({
      action: shareTarget.action,
      method: shareTarget.method,
      enctype: shareTarget.enctype,
    }).toEqual({
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
    });
    expect(shareTarget.params.files[0].name).toBe("files");
  });

  it("shares exactly the union of the attachment upload allow-lists (shareable == attachable)", () => {
    const shareTarget = manifest.share_target as {
      params: { files: Array<{ accept: string[] }> };
    };
    const manifestAccept = shareTarget.params.files[0].accept;

    // text/vcard is deliberately listed in BOTH ALLOWED_ATTACHMENT_MIMES and
    // ALLOWED_TEXT_MIMES (see upload-validation.ts for why), so a naive
    // concat would contain it twice. De-dup via Set on both sides so the
    // duplicate can't spuriously fail (or silently pass) this comparison.
    const expectedAccept = [
      ...new Set([...ALLOWED_ATTACHMENT_MIMES, ...ALLOWED_TEXT_MIMES]),
    ].sort();

    expect([...new Set(manifestAccept)].sort()).toEqual(expectedAccept);
  });
});
