import { describe, it, expect } from "vitest";
import { INPUT_ACCEPT_ATTRIBUTE } from "@/lib/attachment-mime";
import { ALLOWED_ATTACHMENT_MIMES, ALLOWED_TEXT_MIMES } from "@/lib/upload-validation";

/**
 * Drift guard: the `<input accept>` value on the chat composer's file picker
 * MUST cover every MIME accepted by the server. If someone adds a new MIME
 * to `ALLOWED_ATTACHMENT_MIMES` / `ALLOWED_TEXT_MIMES` without also updating
 * `INPUT_ACCEPT_ATTRIBUTE`, the file picker will silently filter the file
 * out of the chooser dialog — users see a working upload UI but their valid
 * file is greyed out.
 *
 * This test enforces the subset relationship: every server-accepted MIME is
 * reachable through the accept attribute, either by exact match or by a
 * `image/*`-style glob.
 */
describe("INPUT_ACCEPT_ATTRIBUTE", () => {
  const acceptTokens = INPUT_ACCEPT_ATTRIBUTE.split(",").map((t) => t.trim());

  function isAccepted(mime: string): boolean {
    for (const token of acceptTokens) {
      if (token.endsWith("/*")) {
        const prefix = token.slice(0, -1); // "image/*" → "image/"
        if (mime.startsWith(prefix)) return true;
      } else if (token === mime) {
        return true;
      }
    }
    return false;
  }

  it("covers every MIME in ALLOWED_ATTACHMENT_MIMES", () => {
    const missing: string[] = [];
    for (const mime of ALLOWED_ATTACHMENT_MIMES) {
      if (!isAccepted(mime)) missing.push(mime);
    }
    expect(
      missing,
      `Server accepts these but the picker filters them out: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("covers every MIME in ALLOWED_TEXT_MIMES", () => {
    const missing: string[] = [];
    for (const mime of ALLOWED_TEXT_MIMES) {
      if (!isAccepted(mime)) missing.push(mime);
    }
    expect(
      missing,
      `Server accepts these but the picker filters them out: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("is a single non-empty comma-separated string with no whitespace tokens", () => {
    // Tighten the contract so a future refactor can't sneak in an empty
    // token (",,") that's a valid no-op in HTML but signals a mistake.
    expect(INPUT_ACCEPT_ATTRIBUTE.length).toBeGreaterThan(0);
    expect(acceptTokens.every((t) => t.length > 0)).toBe(true);
  });
});
