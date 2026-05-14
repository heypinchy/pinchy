import { describe, expect, it, vi } from "vitest";
import { decodeRef, encodeRef } from "../integration-ref";

describe("integration refs", () => {
  it("roundtrips an opaque Odoo reference", () => {
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));

    const ref = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "res.country",
      id: 14,
      label: "Austria",
    });

    expect(ref).toMatch(/^pinchy_ref:v1:/);
    expect(ref).not.toContain("Austria");
    expect(ref).not.toContain("res.country");
    expect(decodeRef(ref)).toEqual({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "res.country",
      id: 14,
      label: "Austria",
    });
  });

  it("rejects tampered references", () => {
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
    const ref = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "res.country",
      id: 14,
      label: "Austria",
    });

    // Corrupt a character well before the end to avoid base64url end-padding
    // effects: in the final 2-char or 3-char group, trailing bits are
    // zero-padded and changing only those bits leaves the decoded bytes
    // unchanged, which would make AES-GCM auth pass. Position -10 is safely
    // inside a full 4-char group where all 6 bits of every character matter.
    const idx = ref.length - 10;
    const flipped = ref[idx] === "a" ? "b" : "a";
    const tampered = ref.slice(0, idx) + flipped + ref.slice(idx + 1);

    expect(() => decodeRef(tampered)).toThrow(/Invalid integration reference/);
  });
});
