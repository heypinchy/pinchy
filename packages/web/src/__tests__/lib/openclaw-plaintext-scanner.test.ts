import { describe, it, expect } from "vitest";
import { assertNoPlaintextSecrets, findPlaintextSecrets } from "@/lib/openclaw-plaintext-scanner";

describe("findPlaintextSecrets", () => {
  it("flags Anthropic-style keys", () => {
    expect(findPlaintextSecrets({ env: { ANTHROPIC_API_KEY: "sk-ant-abcdef1234567890" } })).toEqual(
      [{ path: "env.ANTHROPIC_API_KEY", pattern: "anthropic" }]
    );
  });

  it("flags OpenAI-style keys", () => {
    expect(
      findPlaintextSecrets({ env: { OPENAI_API_KEY: "sk-proj-abcdefghijklmnopqrst" } })
    ).toEqual([{ path: "env.OPENAI_API_KEY", pattern: "openai-generic" }]);
  });

  it("flags Ollama Cloud keys", () => {
    // Real format: 32 hex chars + "." + ≥16 base62 chars (observed in
    // production secrets.json). The leak path that worried us: a future
    // refactor that bypasses SecretRef and lands the raw key in env.*
    // or a provider apiKey field — the scanner has to catch it.
    expect(
      findPlaintextSecrets({
        providers: {
          "ollama-cloud": { apiKey: "d09762adf39c4d1cbdca5f5fc7ca13d5.JyGHlyB0m9yYcpIVkavQIBH7" },
        },
      })
    ).toEqual([{ path: "providers.ollama-cloud.apiKey", pattern: "ollama-cloud" }]);
  });

  it("accepts Telegram bot tokens as plain strings (OpenClaw 2026.4.26 does not support SecretRef in channel configs)", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: { a1: { botToken: "110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw" } },
        },
      },
    };
    expect(findPlaintextSecrets(cfg)).toHaveLength(0);
  });

  it("accepts SecretRef objects (no match)", () => {
    const cfg = {
      env: {
        ANTHROPIC_API_KEY: {
          source: "file",
          provider: "pinchy",
          id: "/providers/anthropic/apiKey",
        },
      },
    };
    expect(findPlaintextSecrets(cfg)).toEqual([]);
  });

  it("accepts ${VAR} env templates (no match)", () => {
    // OpenClaw rejects SecretRef objects in env.* — Pinchy writes ${VAR}
    // template strings instead. The scanner must let those through.
    const cfg = {
      env: {
        ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
        OPENAI_API_KEY: "${OPENAI_API_KEY}",
      },
    };
    expect(findPlaintextSecrets(cfg)).toEqual([]);
  });

  it("returns empty for clean configs", () => {
    expect(findPlaintextSecrets({ gateway: { mode: "local", bind: "lan" } })).toEqual([]);
  });
});

describe("assertNoPlaintextSecrets", () => {
  it("throws when plaintext found", () => {
    expect(() =>
      assertNoPlaintextSecrets({ env: { ANTHROPIC_API_KEY: "sk-ant-leaked1234567890" } })
    ).toThrow(/plaintext secret detected/i);
  });

  it("does not throw for clean configs", () => {
    expect(() =>
      assertNoPlaintextSecrets({ gateway: { mode: "local", bind: "lan" } })
    ).not.toThrow();
  });
});
