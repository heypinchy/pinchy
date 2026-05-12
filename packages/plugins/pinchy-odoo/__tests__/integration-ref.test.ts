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

    expect(() => decodeRef(ref.replace(/.$/, "x"))).toThrow(
      /Invalid integration reference/,
    );
  });
});
