/**
 * Schema-level integration test: emitted openclaw.json must load cleanly under
 * the actual OpenClaw runtime. Catches the "Pinchy emits config that OC rejects
 * at startup" bug class — not just baseUrl.
 *
 * Bug report: v0.5.0 deployments with Anthropic/OpenAI keys (no env-var overrides)
 * crashed OpenClaw in a restart loop with:
 *   models.providers.anthropic.baseUrl: Invalid input: expected string, received undefined
 * Fixed in v0.5.1.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve([]), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([]),
        })
      ),
    })),
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (val: string) => val,
  encrypt: (val: string) => val,
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn().mockResolvedValue("anthropic/claude-haiku-4-5-20251001"),
}));

describe("openclaw.json emitted by Pinchy validates under OpenClaw's own loader", () => {
  let tmpConfigDir: string;
  let tmpSecretsDir: string;

  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), "pinchy-config-"));
    tmpSecretsDir = mkdtempSync(join(tmpdir(), "pinchy-secrets-"));

    process.env.OPENCLAW_CONFIG_PATH = join(tmpConfigDir, "openclaw.json");
    process.env.OPENCLAW_SECRETS_PATH = join(tmpSecretsDir, "secrets.json");
    process.env.OPENCLAW_SECRETS_PATH_IN_OPENCLAW = join(tmpSecretsDir, "secrets.json");

    // CRITICAL: do NOT set ANTHROPIC_BASE_URL / OPENAI_BASE_URL / GOOGLE_BASE_URL.
    // Production deployments have no env-var overrides — this is the path the bug hit.
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.GOOGLE_BASE_URL;

    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_SECRETS_PATH;
    delete process.env.OPENCLAW_SECRETS_PATH_IN_OPENCLAW;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    rmSync(tmpSecretsDir, { recursive: true, force: true });
  });

  it("loads cleanly with anthropic + openai keys configured (no env-var overrides)", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test";
      if (key === "openai_api_key") return "sk-openai-test";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    // loadConfig() is synchronous. It reads OPENCLAW_CONFIG_PATH from process.env
    // and throws if the config fails OC's own Zod schema validation. Before v0.5.1,
    // this threw: "models.providers.anthropic.baseUrl: Invalid input: expected
    // string, received undefined" — exactly the customer's error.
    const { loadConfig } = await import("openclaw");
    expect(() => loadConfig()).not.toThrow();
    // openclaw ESM cold import is slow in a full-suite run; 10s ceiling avoids
    // false-positive timeouts while still catching genuine hangs.
  }, 10_000);
});
