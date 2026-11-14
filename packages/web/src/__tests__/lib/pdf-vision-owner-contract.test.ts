// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeConfigToAgent } from "../../../../plugins/pinchy-files/pdf-vision-api";

/**
 * Contract test against the real OpenClaw, not a mock of it.
 *
 * pinchy-files resolves the vision API key through the plugin runtime's
 * `modelAuth.resolveApiKeyForProvider`. OpenClaw 2026.9 has no default
 * agent, and that wrapper forwards only `{ provider, cfg, workspaceDir }`,
 * so the plugin names the reading agent as `agents.defaults.systemAgent`
 * in a copy of `cfg`. That this field decides the owner is an OpenClaw
 * internal. A mock that re-encoded the assumed contract once passed while
 * production failed (an `agentDir` the wrapper silently dropped), so this
 * pins the behaviour of the installed version: an OpenClaw bump that moves
 * the owner lookup goes red here instead of leaving scanned PDFs unread.
 */

// The SDK entry points ship without type declarations; a string specifier
// keeps them out of the type graph.
const SDK = "openclaw/plugin-sdk/";
type ResolveApiKey = (params: {
  provider: string;
  cfg: unknown;
}) => Promise<{ apiKey?: string } | null>;

let stateDir: string;
let resolveApiKeyForProvider: ResolveApiKey;
const previousStateDir = process.env.OPENCLAW_STATE_DIR;

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "pinchy-vision-owner-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const authRuntime = (await import(/* @vite-ignore */ `${SDK}provider-auth-runtime`)) as {
    resolveApiKeyForProvider: ResolveApiKey;
  };
  resolveApiKeyForProvider = authRuntime.resolveApiKeyForProvider;
});

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

// Two agents and no system agent: the shape on which 2026.9 refuses to
// guess an owner.
const multiAgentConfig = {
  agents: {
    ownership: "explicit",
    defaults: {},
    entries: {
      smithers: { name: "Smithers" },
      "kb-agent": { name: "Knowledge Base" },
    },
  },
  models: {
    providers: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        apiKey: "sk-ant-contract-test",
        models: [],
      },
    },
  },
};

describe("vision key owner contract with the installed OpenClaw", () => {
  it("refuses to resolve a provider key without an owner on a multi-agent config", async () => {
    // If this starts passing, OpenClaw picks an owner on its own again and
    // the scoping in pdf-vision-api.ts may no longer be needed.
    await expect(
      resolveApiKeyForProvider({ provider: "anthropic", cfg: multiAgentConfig })
    ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
  });

  it("resolves the key once the config names the reading agent", async () => {
    const result = await resolveApiKeyForProvider({
      provider: "anthropic",
      cfg: scopeConfigToAgent(multiAgentConfig, "kb-agent"),
    });

    expect(result?.apiKey).toBe("sk-ant-contract-test");
  });
});
