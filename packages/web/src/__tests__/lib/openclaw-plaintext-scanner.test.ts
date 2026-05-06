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

  describe("MCP token prefixes", () => {
    it("flags GitHub classic PAT (ghp_)", () => {
      expect(
        findPlaintextSecrets({
          plugins: { mcp: { token: "ghp_abcdefghijklmnopqrstuvwxyz123456" } },
        })
      ).toEqual([{ path: "plugins.mcp.token", pattern: "github-pat-classic" }]);
    });

    it("flags GitHub fine-grained PAT (github_pat_)", () => {
      expect(
        findPlaintextSecrets({
          plugins: { mcp: { token: "github_pat_11ABCDE0A_abcdefghijklmnopqrstuvwxyz" } },
        })
      ).toEqual([{ path: "plugins.mcp.token", pattern: "github-pat-fine-grained" }]);
    });

    it("flags GitHub OAuth token (gho_)", () => {
      expect(
        findPlaintextSecrets({
          plugins: { mcp: { token: "gho_abcdefghijklmnopqrstuvwxyz123456" } },
        })
      ).toEqual([{ path: "plugins.mcp.token", pattern: "github-oauth" }]);
    });

    it("flags Notion internal integration token (secret_)", () => {
      expect(
        findPlaintextSecrets({
          plugins: { mcp: { token: "secret_abcdefghijklmnopqrstuvwxyz12345678901234567890" } },
        })
      ).toEqual([{ path: "plugins.mcp.token", pattern: "notion-integration" }]);
    });

    it("flags Linear API key (lin_api_)", () => {
      expect(
        findPlaintextSecrets({ plugins: { mcp: { token: "lin_api_abcdefghijklmnopqrstuvwxyz" } } })
      ).toEqual([{ path: "plugins.mcp.token", pattern: "linear-api-key" }]);
    });

    it("does not flag a clean config with no MCP tokens", () => {
      const cleanCfg = {
        plugins: {
          entries: {
            "pinchy-mcp": {
              enabled: true,
              config: {
                apiBaseUrl: "http://pinchy:7777",
                gatewayToken: "gw-bootstrap-token",
                connections: [
                  {
                    connectionId: "conn-abc",
                    preset: "github",
                    transport: "http",
                    url: "https://api.githubcopilot.com/mcp/",
                    toolPrefix: "github_",
                    agentTools: { "agent-xyz": ["create_issue"] },
                  },
                ],
              },
            },
          },
        },
      };
      expect(findPlaintextSecrets(cleanCfg)).toHaveLength(0);
    });
  });
});

describe("assertNoPlaintextSecrets", () => {
  it("throws when plaintext found", () => {
    expect(() =>
      assertNoPlaintextSecrets({ env: { ANTHROPIC_API_KEY: "sk-ant-leaked1234567890" } })
    ).toThrow(/plaintext secret detected/i);
  });

  it("throws when a leaked GitHub PAT is found", () => {
    expect(() =>
      assertNoPlaintextSecrets({
        plugins: { mcp: { token: "ghp_abcdefghijklmnopqrstuvwxyz123456" } },
      })
    ).toThrow(/plaintext secret detected/i);
  });

  it("does not throw for clean configs", () => {
    expect(() =>
      assertNoPlaintextSecrets({ gateway: { mode: "local", bind: "lan" } })
    ).not.toThrow();
  });
});
