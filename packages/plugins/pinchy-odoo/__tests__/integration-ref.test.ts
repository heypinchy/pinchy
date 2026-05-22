// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decodeRef, encodeRef, _resetKeyCacheForTest } from "../integration-ref";

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

  describe("key source order (env → secrets.json → throw)", () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-odoo-ref-"));
      _resetKeyCacheForTest();
      vi.unstubAllEnvs();
    });

    afterEach(() => {
      _resetKeyCacheForTest();
      vi.unstubAllEnvs();
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("uses PINCHY_REF_TOKEN_KEY env var when set (priority 1)", () => {
      vi.stubEnv("PINCHY_REF_TOKEN_KEY", "f".repeat(64));
      // No secrets.json path, no /app/secrets dir — env var alone must suffice.
      vi.stubEnv("OPENCLAW_SECRETS_PATH", join(tmpRoot, "does-not-exist.json"));

      const ref = encodeRef({
        integrationType: "odoo",
        connectionId: "conn-A",
        model: "res.partner",
        id: 1,
        label: "ACME",
      });
      expect(decodeRef(ref).label).toBe("ACME");
    });

    it("reads plugins['pinchy-odoo'].refTokenKey from secrets.json (priority 2)", () => {
      const secretsPath = join(tmpRoot, "secrets.json");
      writeFileSync(
        secretsPath,
        JSON.stringify({
          plugins: { "pinchy-odoo": { refTokenKey: "c".repeat(64) } },
        }),
      );
      vi.stubEnv("OPENCLAW_SECRETS_PATH", secretsPath);
      // Env var deliberately not set.
      vi.stubEnv("PINCHY_REF_TOKEN_KEY", "");

      const ref = encodeRef({
        integrationType: "odoo",
        connectionId: "conn-B",
        model: "res.partner",
        id: 2,
        label: "Foo",
      });
      // Decode under same conditions to confirm we used the secrets-file key.
      expect(decodeRef(ref).label).toBe("Foo");
    });

    it("env var beats secrets.json when both are present", () => {
      const secretsPath = join(tmpRoot, "secrets.json");
      writeFileSync(
        secretsPath,
        JSON.stringify({
          plugins: { "pinchy-odoo": { refTokenKey: "1".repeat(64) } },
        }),
      );
      vi.stubEnv("OPENCLAW_SECRETS_PATH", secretsPath);
      vi.stubEnv("PINCHY_REF_TOKEN_KEY", "2".repeat(64));

      const ref = encodeRef({
        integrationType: "odoo",
        connectionId: "conn-C",
        model: "res.partner",
        id: 3,
        label: "Bar",
      });

      // Switch to secrets-only and verify the env-var key was used (decode fails).
      _resetKeyCacheForTest();
      vi.stubEnv("PINCHY_REF_TOKEN_KEY", "");
      expect(() => decodeRef(ref)).toThrow(/Invalid integration reference/);
    });

    it("throws a clear error if no env var and no secrets.json entry", () => {
      const secretsPath = join(tmpRoot, "no-plugins.json");
      writeFileSync(secretsPath, JSON.stringify({ gateway: { token: "x" } }));
      vi.stubEnv("OPENCLAW_SECRETS_PATH", secretsPath);
      vi.stubEnv("PINCHY_REF_TOKEN_KEY", "");

      expect(() =>
        encodeRef({
          integrationType: "odoo",
          connectionId: "conn-X",
          model: "res.partner",
          id: 4,
          label: "x",
        }),
      ).toThrow(/PINCHY_REF_TOKEN_KEY|secrets\.json/i);
    });

    it("rejects malformed key in secrets.json (not 64 hex)", () => {
      const secretsPath = join(tmpRoot, "bad-secrets.json");
      writeFileSync(
        secretsPath,
        JSON.stringify({
          plugins: { "pinchy-odoo": { refTokenKey: "not-hex" } },
        }),
      );
      vi.stubEnv("OPENCLAW_SECRETS_PATH", secretsPath);
      vi.stubEnv("PINCHY_REF_TOKEN_KEY", "");

      expect(() =>
        encodeRef({
          integrationType: "odoo",
          connectionId: "conn-X",
          model: "res.partner",
          id: 4,
          label: "x",
        }),
      ).toThrow(/64 hex|invalid/i);
    });

    it("does NOT auto-generate a key into a local fallback directory", () => {
      // Even if /app/secrets exists, the plugin should refuse to write — keys
      // come from pinchy-web through the secrets bundle, not from random
      // in-container generation that wouldn't survive container restarts.
      const fakeAppSecrets = join(tmpRoot, "app-secrets");
      mkdirSync(fakeAppSecrets, { recursive: true });
      vi.stubEnv("ENCRYPTION_KEY_DIR", fakeAppSecrets);
      vi.stubEnv("PINCHY_REF_TOKEN_KEY", "");
      vi.stubEnv(
        "OPENCLAW_SECRETS_PATH",
        join(tmpRoot, "no-such-file.json"),
      );

      expect(() =>
        encodeRef({
          integrationType: "odoo",
          connectionId: "conn-X",
          model: "res.partner",
          id: 4,
          label: "x",
        }),
      ).toThrow();
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

  describe("optional company fields", () => {
    beforeEach(() => {
      _resetKeyCacheForTest();
      vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
    });

    it("roundtrips a payload with companyId and companyLabel", () => {
      const ref = encodeRef({
        integrationType: "odoo",
        connectionId: "conn-mc",
        model: "account.account",
        id: 42,
        label: "1000 Wareneinsatz [GmbH A]",
        companyId: 1,
        companyLabel: "GmbH A",
      });
      expect(decodeRef(ref)).toEqual({
        integrationType: "odoo",
        connectionId: "conn-mc",
        model: "account.account",
        id: 42,
        label: "1000 Wareneinsatz [GmbH A]",
        companyId: 1,
        companyLabel: "GmbH A",
      });
    });

    it("still accepts a payload without company fields (back-compat with old tokens)", () => {
      const ref = encodeRef({
        integrationType: "odoo",
        connectionId: "conn-legacy",
        model: "res.country",
        id: 14,
        label: "Austria",
      });
      expect(decodeRef(ref)).toEqual({
        integrationType: "odoo",
        connectionId: "conn-legacy",
        model: "res.country",
        id: 14,
        label: "Austria",
      });
    });

    it("rejects a payload where companyId is not a positive integer", () => {
      expect(() =>
        encodeRef({
          integrationType: "odoo",
          connectionId: "conn-bad",
          model: "account.account",
          id: 42,
          label: "x",
          companyId: -1,
          companyLabel: "Bad",
        }),
      ).toThrow(/Invalid integration reference payload/);
    });

    it("rejects a payload where companyLabel is present but companyId is not", () => {
      expect(() =>
        encodeRef({
          integrationType: "odoo",
          connectionId: "conn-bad-2",
          model: "account.account",
          id: 42,
          label: "x",
          // @ts-expect-error: deliberate mis-shape for the validator
          companyLabel: "Orphan",
        }),
      ).toThrow(/Invalid integration reference payload/);
    });

    it("rejects a payload where companyId is present but companyLabel is not", () => {
      expect(() =>
        encodeRef({
          integrationType: "odoo",
          connectionId: "conn-bad-3",
          model: "account.account",
          id: 42,
          label: "x",
          // @ts-expect-error: deliberate mis-shape for the validator
          companyId: 1,
        }),
      ).toThrow(/Invalid integration reference payload/);
    });

    it("rejects a payload where companyId is not an integer", () => {
      expect(() =>
        encodeRef({
          integrationType: "odoo",
          connectionId: "conn-bad-4",
          model: "account.account",
          id: 42,
          label: "x",
          companyId: 1.5,
          companyLabel: "Half",
        }),
      ).toThrow(/Invalid integration reference payload/);
    });

    it("rejects a payload where companyLabel is an empty string", () => {
      expect(() =>
        encodeRef({
          integrationType: "odoo",
          connectionId: "conn-bad-5",
          model: "account.account",
          id: 42,
          label: "x",
          companyId: 1,
          companyLabel: "",
        }),
      ).toThrow(/Invalid integration reference payload/);
    });
  });
});
