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

  it("flags Telegram bot tokens", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: { a1: { botToken: "123456789:AAEhBP0av28_abcdefghijklmnopqrstuvw" } },
        },
      },
    };
    expect(findPlaintextSecrets(cfg)).toHaveLength(1);
    expect(findPlaintextSecrets(cfg)[0].path).toBe("channels.telegram.accounts.a1.botToken");
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
