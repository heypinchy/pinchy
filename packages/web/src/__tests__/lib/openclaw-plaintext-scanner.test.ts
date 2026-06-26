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

    it("flags GitLab personal access token (glpat-)", () => {
      expect(
        findPlaintextSecrets({
          plugins: { mcp: { token: "glpat-abcdefghijklmnopqrstuvwx" } },
        })
      ).toEqual([{ path: "plugins.mcp.token", pattern: "gitlab-pat" }]);
    });

    it("flags GitLab project access token (glptt-)", () => {
      expect(
        findPlaintextSecrets({
          plugins: { mcp: { token: "glptt-abcdefghijklmnopqrstuvwx" } },
        })
      ).toEqual([{ path: "plugins.mcp.token", pattern: "gitlab-project-token" }]);
    });

    // Stripe live-mode fixtures are built via string concat so GitHub's
    // push-protection static scanner doesn't flag them as real keys. The
    // assembled values at runtime still match the regex we're testing.
    it("flags Stripe restricted key (rk_live_)", () => {
      const stripeLiveRestricted = "rk_" + "live_" + "abcdefghijklmnopqrstuvwxyz";
      expect(
        findPlaintextSecrets({
          plugins: { mcp: { token: stripeLiveRestricted } },
        })
      ).toEqual([{ path: "plugins.mcp.token", pattern: "stripe-restricted-key" }]);
    });

    it("flags Stripe restricted test key (rk_test_)", () => {
      expect(
        findPlaintextSecrets({
          plugins: { mcp: { token: "rk_test_abcdefghijklmnopqrstuvwxyz" } },
        })
      ).toEqual([{ path: "plugins.mcp.token", pattern: "stripe-restricted-key" }]);
    });

    it("flags Stripe secret key (sk_live_)", () => {
      const stripeLiveSecret = "sk_" + "live_" + "abcdefghijklmnopqrstuvwxyz";
      expect(
        findPlaintextSecrets({
          plugins: { mcp: { token: stripeLiveSecret } },
        })
      ).toEqual([{ path: "plugins.mcp.token", pattern: "stripe-secret-key" }]);
    });

    it("flags HighLevel Private Integration Token (pit-)", () => {
      expect(
        findPlaintextSecrets({
          plugins: { mcp: { token: "pit-0123456789abcdef0123456789abcdef" } },
        })
      ).toEqual([{ path: "plugins.mcp.token", pattern: "highlevel-pit" }]);
    });

    it("does not flag harmless strings that start with similar prefixes", () => {
      // Tighten the regression net — "rk_" alone shouldn't trip Stripe, and a
      // short "pit-" shouldn't trip HighLevel either.
      expect(
        findPlaintextSecrets({
          notes: "rk_live_short",
          tag: "pit-short",
        })
      ).toEqual([]);
    });

    it("does not flag a clean native MCP config (proxy URL + gateway token, no third-party secret)", () => {
      const cleanCfg = {
        mcp: {
          servers: {
            // Native mcp.servers points at the Pinchy proxy; the only header is
            // the opaque gateway bootstrap token (not a recognized third-party
            // prefix), and the real token lives in the DB — never in the config.
            mconnabc: {
              url: "http://pinchy:7777/api/internal/mcp-proxy/conn-abc",
              transport: "streamable-http",
              headers: { Authorization: "Bearer gw-bootstrap-token" },
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
