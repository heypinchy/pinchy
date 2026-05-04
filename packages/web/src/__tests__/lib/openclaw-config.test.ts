import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(true);
  const mkdirSyncMock = vi.fn();
  const renameSyncMock = vi.fn();
  const chmodSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: writeFileSyncMock,
      readFileSync: readFileSyncMock,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
      renameSync: renameSyncMock,
      chmodSync: chmodSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    renameSync: renameSyncMock,
    chmodSync: chmodSyncMock,
  };
});

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

const { mockDecrypt } = vi.hoisted(() => ({
  mockDecrypt: vi.fn((val: string) => val),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (val: string) => mockDecrypt(val),
  encrypt: (val: string) => val,
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

const { mockedGetOrCreateGatewayToken } = vi.hoisted(() => ({
  mockedGetOrCreateGatewayToken: vi.fn().mockResolvedValue("test-gateway-token"),
}));

vi.mock("@/lib/gateway-token-source", () => ({
  getOrCreateGatewayToken: mockedGetOrCreateGatewayToken,
}));

const { mockWriteSecretsFile, mockReadSecretsFile } = vi.hoisted(() => ({
  mockWriteSecretsFile: vi.fn(),
  mockReadSecretsFile: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/openclaw-secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-secrets")>();
  return {
    ...actual,
    writeSecretsFile: mockWriteSecretsFile,
    readSecretsFile: mockReadSecretsFile,
  };
});

vi.mock("@/lib/provider-models", () => {
  const defaults: Record<string, string> = {
    anthropic: "anthropic/claude-haiku-4-5-20251001",
    openai: "openai/gpt-5.4-mini",
    google: "google/gemini-2.5-flash",
    "ollama-cloud": "ollama-cloud/gemini-3-flash-preview",
    "ollama-local": "",
  };
  return {
    getDefaultModel: vi.fn(async (provider: string) => defaults[provider] ?? ""),
  };
});

const { mockGetClient, mockConfigGet, mockConfigApply } = vi.hoisted(() => ({
  mockGetClient: vi.fn(),
  mockConfigGet: vi.fn(),
  mockConfigApply: vi.fn(),
}));

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import {
  regenerateOpenClawConfig,
  updateIdentityLinks,
  sanitizeOpenClawConfig,
  updateTelegramChannelConfig,
} from "@/lib/openclaw-config";
import { pushConfigInBackground, _resetPushGeneration } from "@/lib/openclaw-config/write";
import { db } from "@/db";
import { getSetting } from "@/lib/settings";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

const mockedDb = vi.mocked(db);
const mockedGetSetting = vi.mocked(getSetting);

/**
 * Helper: create a mock `innerJoin()` that returns a thenable supporting `.where()`.
 * This models the new query chain: select().from().innerJoin().where().
 */
function mockInnerJoin(data: unknown[] = []) {
  return vi.fn().mockReturnValue(
    Object.assign(Promise.resolve(data), {
      where: vi.fn().mockResolvedValue(data),
    })
  );
}

/** Helper: create a mock `from()` that returns a thenable with `.innerJoin()` and `.where()` */
function mockFrom(data: unknown[] = []) {
  return vi.fn().mockImplementation(() =>
    Object.assign(Promise.resolve(data), {
      innerJoin: mockInnerJoin([]),
      where: vi.fn().mockResolvedValue(data),
    })
  );
}

/**
 * Drain `regenerateOpenClawConfig`'s fire-and-forget background coroutine
 * (see `pushConfigInBackground` in openclaw-config.ts) before continuing.
 *
 * Two `setImmediate` rounds are enough for the success path: round 1 lets
 * the dynamic `import()` resolve; round 2 lets the `await client.config.get`
 * → `await client.config.apply` → `return` chain settle. Without this
 * drain, an unsettled continuation can call into mocks that the *next*
 * test's `beforeEach` has already reconfigured (cross-test pollution).
 */
async function drainBackgroundCoroutine(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("regenerateOpenClawConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetOrCreateGatewayToken.mockResolvedValue("test-gateway-token");
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockReadSecretsFile.mockReturnValue({});
    mockedDb.select.mockReturnValue({
      from: mockFrom(),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
    // Default: no OpenClaw client connected — exercises the cold-start path
    // that falls back to writing the file directly. Individual tests can
    // override mockGetClient to return a connected client.
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });
    // Reset the push-generation counter so stale background coroutines from a
    // previous test's pushConfigInBackground retry loop cannot sneak past the
    // generation check during the 300ms readExistingConfig async retry window.
    _resetPushGeneration();
  });

  it("should write config with restrictive file permissions", async () => {
    await regenerateOpenClawConfig();

    expect(mockedWriteFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      encoding: "utf-8",
      mode: 0o644,
    });
  });

  it("should disable heartbeat per agent in agents.list", async () => {
    // Rationale: Heartbeat fires LLM calls in the background and racks up
    // tokens for every agent, even idle ones. Pinchy disables it by default
    // (`heartbeat: { every: "0m" }`). We set it per-agent, NOT on agents.defaults,
    // to avoid hot-reload races with Telegram (openclaw#47458).
    const agentsData = [
      { id: "a1", name: "Smithers", model: "anthropic/claude-opus-4-7", createdAt: new Date() },
      { id: "a2", name: "Jeeves", model: "openai/gpt-5.4", createdAt: new Date() },
    ];
    mockedDb.select.mockReturnValue({
      from: mockFrom(agentsData),
    } as never);
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    for (const agent of config.agents.list) {
      expect(agent.heartbeat).toEqual({ every: "0m" });
    }
    // Must NOT be in agents.defaults (would cause hot-reload loops)
    expect(config.agents.defaults?.heartbeat).toBeUndefined();
  });

  it("should disable OpenClaw features that have no purpose in a containerized Pinchy deployment", async () => {
    // Three OpenClaw features serve no purpose in the Pinchy server stack
    // (Pinchy is the user-facing UI on port 7777 and the only operator
    // surface; OpenClaw runs inside a Docker container with no human ever
    // hitting its HTTP port directly):
    //
    //   - update.checkOnStart=true (default): runs `npm view openclaw versions`
    //     on every gateway boot to surface "update available" log lines.
    //     Pinchy controls the OpenClaw version through the Docker image tag
    //     and ignores the notice; the network call is wasted I/O at startup.
    //
    //   - gateway.controlUi.enabled=true (default): exposes OpenClaw's own
    //     web UI under /__openclaw__/control/* on the gateway HTTP port.
    //     Pinchy IS the external control surface (per the schema's own
    //     guidance: "disable when an external control surface replaces it").
    //     Disabling cuts memory + reduces the attack surface — and makes
    //     the controlUi.dangerously* sub-toggles moot.
    //
    //   - canvasHost.enabled=true (default): hosts OpenClaw's "canvas"
    //     artifact server. Pinchy doesn't render OpenClaw canvases anywhere
    //     in its UI; the schema says "Keep disabled when canvas workflows
    //     are inactive to reduce exposed local services."
    //
    // All three are written by regenerateOpenClawConfig() BEFORE the first
    // gateway boot (OpenClaw's depends_on Pinchy's healthcheck ensures this).
    // The paths are restart-classified by OpenClaw, so writing them once at
    // startup avoids any SIGUSR1 on the first Pinchy regenerate.
    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written) as {
      update?: { checkOnStart?: boolean };
      gateway?: { controlUi?: { enabled?: boolean } };
      canvasHost?: { enabled?: boolean };
    };
    expect(config.update?.checkOnStart).toBe(false);
    expect(config.gateway?.controlUi?.enabled).toBe(false);
    expect(config.canvasHost?.enabled).toBe(false);
  });

  it("preserves OpenClaw-enriched sub-fields under discovery, update, canvasHost across regenerate (C1)", async () => {
    // Regression guard for review feedback on PR #269: writing
    // `discovery`, `update`, `canvasHost` as fresh objects without
    // spreading `existing.<field>` first re-introduces the same bug
    // class this PR is meant to close (#193, #237). If OpenClaw enriches
    // a sub-field under any of these three new top-level paths and we
    // strip it on the next regenerate, OpenClaw re-stamps it on the
    // following reload — endless restart cascade.
    //
    // We seed `existing` with one OpenClaw-style enrichment under each
    // path and assert it survives Pinchy's regenerate.
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan", auth: { token: "tok" } },
        discovery: {
          mdns: { mode: "minimal", lastAnnouncedAt: "2026-05-03T00:00:00Z" },
          lan: { discoveredPeers: ["peer-1"] },
        },
        update: { lastCheckedAt: "2026-05-03T00:00:00Z", channel: "stable" },
        canvasHost: { enabled: true, boundPort: 18792 },
      })
    );

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written) as {
      discovery?: {
        mdns?: { mode?: string; lastAnnouncedAt?: string };
        lan?: { discoveredPeers?: string[] };
      };
      update?: { checkOnStart?: boolean; lastCheckedAt?: string; channel?: string };
      canvasHost?: { enabled?: boolean; boundPort?: number };
    };

    // Pinchy's intent: mode=off, checkOnStart=false, enabled=false (the
    // disables this PR adds).
    expect(config.discovery?.mdns?.mode).toBe("off");
    expect(config.update?.checkOnStart).toBe(false);
    expect(config.canvasHost?.enabled).toBe(false);

    // OpenClaw's enrichments must survive byte-for-byte. If any of these
    // assertions fail, regenerate is stripping them and the cascade is
    // back.
    expect(config.discovery?.mdns?.lastAnnouncedAt).toBe("2026-05-03T00:00:00Z");
    expect(config.discovery?.lan?.discoveredPeers).toEqual(["peer-1"]);
    expect(config.update?.lastCheckedAt).toBe("2026-05-03T00:00:00Z");
    expect(config.update?.channel).toBe("stable");
    expect(config.canvasHost?.boundPort).toBe(18792);
  });

  it("should disable mDNS discovery so the Bonjour watchdog can't kill the gateway", async () => {
    // Rationale: OpenClaw's gateway tries to advertise itself via mDNS
    // (Bonjour) on startup. In Docker bridge networks multicast doesn't
    // route out of the container, so OpenClaw's announcer hangs in
    // `state=announcing`. After 16 s its internal watchdog raises a
    // SIGTERM ("[bonjour] restarting advertiser (service stuck in
    // announcing for 16622ms)") and forces a full gateway restart —
    // costing ~30 s of "Reconnecting to the agent…" downtime per cold
    // start (observed on staging 2026-05-03).
    //
    // Pinchy always runs OpenClaw inside a container, so mDNS is never
    // useful for us — we connect via OPENCLAW_WS_URL on the bridge
    // network. Writing `discovery.mdns.mode = "off"` into the config
    // disables the announcer up-front, the watchdog never fires, no
    // restart cascade.
    //
    // Schema reference (openclaw 2026.4.x):
    //   discovery.mdns.mode: "off" | "minimal" | "full"
    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written) as { discovery?: { mdns?: { mode?: string } } };
    expect(config.discovery?.mdns?.mode).toBe("off");
  });

  it("should disable bundled OpenClaw plugins that Pinchy never uses", async () => {
    // OpenClaw 2026.4.x ships seven plugins enabledByDefault:
    //   acpx, bonjour, browser, device-pair, memory-core, phone-control, talk-voice
    //
    // Pinchy uses none of acpx, bonjour, device-pair, phone-control:
    //   - acpx: Agent Client Protocol for desktop chat clients (Claude.app,
    //     Zed Codex). Pinchy talks to OpenClaw via its WebSocket gateway
    //     (openclaw-node), not ACP — the plugin is dead weight.
    //   - bonjour: mDNS service advertising for the gateway. Pinchy reaches
    //     OpenClaw on the Docker bridge via OPENCLAW_WS_URL; multicast
    //     doesn't route there. discovery.mdns.mode=off already silences
    //     the watchdog, but the plugin itself still loads ~1MB of
    //     @homebridge/ciao deps and starts an announcer.
    //   - device-pair: QR-code pairing flow. Pinchy auto-approves devices
    //     via gateway-token auth in start-openclaw.sh.
    //   - phone-control: phone-node high-risk command arming. Pinchy has
    //     no phone integration.
    //
    // Disabling them shrinks the bundled runtime-deps install from ~48s on
    // a cold container start (observed on 2-vCPU staging) to ~10–15s, and
    // cuts a few hundred MB from /root/.openclaw/plugin-runtime-deps.
    //
    // browser, memory-core, talk-voice stay enabled: browser is a planned
    // feature (and gated by Pinchy's tool-registry deny-list anyway),
    // memory-core has activation.onStartup=false (zero startup cost),
    // talk-voice is a leaf TTS picker we may want for future voice work.
    //
    // Disable mechanism: plugins.allow is a hard whitelist
    // ("when set, only listed plugins are eligible to load") — the unwanted
    // plugin IDs must never appear there. plugins.entries.<id>.enabled=false
    // is added as defense-in-depth in case some bundled-channel side path
    // re-injects them.
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan", auth: { token: "tok" } },
        plugins: {
          // Simulate OpenClaw having auto-populated allow with all bundled
          // plugins after a previous boot; Pinchy must filter the four out.
          allow: [
            "acpx",
            "bonjour",
            "browser",
            "device-pair",
            "memory-core",
            "phone-control",
            "talk-voice",
          ],
          entries: {
            acpx: { enabled: true },
            bonjour: { enabled: true },
            "device-pair": { enabled: true },
            "phone-control": { enabled: true },
          },
        },
      })
    );

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written) as {
      plugins?: {
        allow?: string[];
        entries?: Record<string, { enabled?: boolean }>;
      };
    };

    const allow = config.plugins?.allow ?? [];
    expect(allow).not.toContain("acpx");
    expect(allow).not.toContain("bonjour");
    expect(allow).not.toContain("device-pair");
    expect(allow).not.toContain("phone-control");

    // browser, memory-core, talk-voice must stay — they're either planned
    // features or zero-cost lazily-activated plugins.
    expect(allow).toContain("browser");
    expect(allow).toContain("memory-core");
    expect(allow).toContain("talk-voice");

    expect(config.plugins?.entries?.acpx?.enabled).toBe(false);
    expect(config.plugins?.entries?.bonjour?.enabled).toBe(false);
    expect(config.plugins?.entries?.["device-pair"]?.enabled).toBe(false);
    expect(config.plugins?.entries?.["phone-control"]?.enabled).toBe(false);
  });

  it("should write agents.list with all agents from DB", async () => {
    const agentsData = [
      {
        id: "uuid-agent-1",
        name: "Smithers",
        model: "anthropic/claude-opus-4-7",
        createdAt: new Date(),
      },
      {
        id: "uuid-agent-2",
        name: "Jeeves",
        model: "openai/gpt-5.4",
        createdAt: new Date(),
      },
    ];
    mockedDb.select.mockReturnValue({
      from: mockFrom(agentsData),
    } as never);

    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.agents.list).toHaveLength(2);
    expect(config.agents.list[0]).toEqual({
      id: "uuid-agent-1",
      name: "Smithers",
      model: "anthropic/claude-opus-4-7",
      workspace: "/root/.openclaw/workspaces/uuid-agent-1",
      tools: { deny: ["group:runtime", "group:fs", "group:web", "pdf", "image", "image_generate"] },
      heartbeat: { every: "0m" },
    });
    expect(config.agents.list[1]).toEqual({
      id: "uuid-agent-2",
      name: "Jeeves",
      model: "openai/gpt-5.4",
      workspace: "/root/.openclaw/workspaces/uuid-agent-2",
      tools: { deny: ["group:runtime", "group:fs", "group:web", "pdf", "image", "image_generate"] },
      heartbeat: { every: "0m" },
    });
  });

  it("writes gateway.auth.token from getOrCreateGatewayToken() (DB wins over existing config)", async () => {
    const existingConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { token: "old-token-in-file" },
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));
    mockedGetOrCreateGatewayToken.mockResolvedValue("new-db-token-xyz");

    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    // DB-sourced token must override whatever is in the existing config file
    expect(config.gateway.auth.token).toBe("new-db-token-xyz");
  });

  it("should preserve existing gateway mode/bind/token in openclaw.json", async () => {
    const existingConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        auth: {
          token: "test-gateway-token",
        },
      },
      meta: {
        version: "1.2.3",
        generatedAt: "2025-01-01T00:00:00Z",
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));
    // Default mock returns "test-gateway-token" — same as existing — so no diff

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // gateway.auth.token comes from getOrCreateGatewayToken() (DB)
    expect(config.gateway.auth).toEqual({
      mode: "token",
      token: "test-gateway-token",
    });
    // OpenClaw-enriched fields (meta, commands, agents.defaults.*) are preserved
    // to avoid unnecessary diffs that trigger hot-reloads breaking Telegram polling
    expect(config.meta).toEqual({ version: "1.2.3", generatedAt: "2025-01-01T00:00:00Z" });
    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
  });

  it("should include provider API keys as SecretRefs in models.providers.*", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-decrypted";
      if (key === "openai_api_key") return "sk-openai-decrypted";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // Provider API keys now use SecretRef in models.providers.* — not env-templates.
    // OpenClaw resolves the SecretRef live from secrets.json without a restart.
    expect(config?.models?.providers?.anthropic?.apiKey).toMatchObject({
      source: "file",
      provider: "pinchy",
      id: "/providers/anthropic/apiKey",
    });
    expect(config?.models?.providers?.openai?.apiKey).toMatchObject({
      source: "file",
      provider: "pinchy",
      id: "/providers/openai/apiKey",
    });
    // No env block for provider keys
    expect(config?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(config?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(config?.env?.GEMINI_API_KEY).toBeUndefined();
  });

  it("should include baseUrl in anthropic provider config when ANTHROPIC_BASE_URL env var is set", async () => {
    // OC 4.27+ with ANTHROPIC_BASE_URL env var requires baseUrl in config.apply payloads.
    // Pinchy must pass it through so both the file write and config.apply succeed.
    process.env.ANTHROPIC_BASE_URL = "https://custom-proxy.example.com:443";
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    try {
      await regenerateOpenClawConfig();
      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);
      expect(config?.models?.providers?.anthropic?.baseUrl).toBe(
        "https://custom-proxy.example.com:443"
      );
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  it("should NOT include baseUrl in anthropic provider config when ANTHROPIC_BASE_URL is not set", async () => {
    delete process.env.ANTHROPIC_BASE_URL;
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();
    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config?.models?.providers?.anthropic?.baseUrl).toBeUndefined();
  });

  it("should set defaults.model from default provider", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "default_provider") return "openai";
      if (key === "openai_api_key") return "sk-openai-key";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.agents.defaults.model.primary).toBe("openai/gpt-5.4-mini");
  });

  it("should handle empty agents list", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom(),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.agents.list).toEqual([]);
  });

  it("should handle no configured providers", async () => {
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // No env block when no provider keys are configured
    expect(config.env).toBeUndefined();
    expect(config.agents.defaults).toEqual({});
  });

  it("should deny all groups for agents with only safe tools", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "kb-agent-id",
          name: "HR Knowledge Base",
          model: "anthropic/claude-haiku-4-5-20251001",
          templateId: "knowledge-base",
          pluginConfig: {
            "pinchy-files": { allowed_paths: ["/data/hr-docs/", "/data/policies/"] },
          },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const kbAgent = config.agents.list.find((a: { id: string }) => a.id === "kb-agent-id");

    expect(kbAgent.tools).toBeDefined();
    expect(kbAgent.tools.deny).toContain("group:runtime");
    expect(kbAgent.tools.deny).toContain("group:fs");
    expect(kbAgent.tools.deny).toContain("group:web");
    expect(kbAgent.tools.allow).toBeUndefined();
  });

  it("should deny all groups for agents with empty allowedTools", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "custom-agent-id",
          name: "Dev Assistant",
          model: "anthropic/claude-opus-4-7",
          templateId: "custom",
          pluginConfig: null,
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const customAgent = config.agents.list.find((a: { id: string }) => a.id === "custom-agent-id");

    expect(customAgent.tools).toBeDefined();
    expect(customAgent.tools.deny).toContain("group:runtime");
    expect(customAgent.tools.deny).toContain("group:fs");
    expect(customAgent.tools.deny).toContain("group:web");
  });

  it("should include pinchy-files plugin config for agents with safe tools", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "kb-agent-id",
          name: "HR Knowledge Base",
          model: "anthropic/claude-haiku-4-5-20251001",
          templateId: "knowledge-base",
          pluginConfig: {
            "pinchy-files": { allowed_paths: ["/data/hr-docs/", "/data/policies/"] },
          },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-files"]).toBeDefined();
    expect(config.plugins.entries["pinchy-files"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-files"].config.agents["kb-agent-id"]).toEqual({
      allowed_paths: ["/data/hr-docs/", "/data/policies/"],
    });
  });

  it("should include apiBaseUrl and gatewayToken in pinchy-files config so the plugin can report vision token usage", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-files" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "kb-agent-id",
          name: "HR Knowledge Base",
          model: "anthropic/claude-haiku-4-5-20251001",
          templateId: "knowledge-base",
          pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr-docs/"] } },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // apiBaseUrl and gatewayToken live at the plugin-level config (alongside `agents`),
    // matching how pinchy-context and pinchy-audit expose them.
    expect(config.plugins.entries["pinchy-files"].config.apiBaseUrl).toBe("http://pinchy:7777");
    // OpenClaw 2026.4.26 does not resolve SecretRef in plugin configs — use plain string
    expect(typeof config.plugins.entries["pinchy-files"].config.gatewayToken).toBe("string");
    // Per-agent allowed_paths is still nested under .agents
    expect(config.plugins.entries["pinchy-files"].config.agents["kb-agent-id"]).toEqual({
      allowed_paths: ["/data/hr-docs/"],
    });
  });

  it("should not keep stale env vars from previous config", async () => {
    const existingConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { token: "existing-token" },
      },
      env: {
        ANTHROPIC_API_KEY: "old-key",
        OPENAI_API_KEY: "stale-key-should-be-removed",
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    // Only Anthropic is configured now
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-new";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // Provider keys now use SecretRef in models.providers.* — no env block
    expect(config?.models?.providers?.anthropic?.apiKey).toMatchObject({
      source: "file",
      provider: "pinchy",
    });
    expect(config.env).toBeUndefined();
    // gateway.auth.token comes from getOrCreateGatewayToken() (DB)
    expect(config.gateway.auth.token).toBe("test-gateway-token");
  });

  it("should include pinchy-context plugin config for agents with context tools", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-6",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context"],
          ownerId: "user-1",
          isPersonal: true,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-context"]).toBeDefined();
    expect(config.plugins.entries["pinchy-context"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-context"].config.apiBaseUrl).toBe("http://pinchy:7777");
    // OpenClaw 2026.4.26 does not resolve SecretRef in plugin configs — use plain string
    expect(typeof config.plugins.entries["pinchy-context"].config.gatewayToken).toBe("string");
    expect(config.plugins.entries["pinchy-context"].config.agents["smithers-1"]).toEqual({
      tools: ["save_user_context"],
      userId: "user-1",
    });
  });

  it("should include pinchy-audit plugin config", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-audit"]).toBeDefined();
    expect(config.plugins.entries["pinchy-audit"].enabled).toBe(true);
    // OpenClaw 2026.4.26 does not resolve SecretRef in plugin configs — use plain string
    expect(config.plugins.entries["pinchy-audit"].config.apiBaseUrl).toBe("http://pinchy:7777");
    expect(typeof config.plugins.entries["pinchy-audit"].config.gatewayToken).toBe("string");
  });

  it("should use PORT env var in plugin apiBaseUrl when set", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    // Simulate custom port
    const originalPort = process.env.PORT;
    process.env.PORT = "7778";

    try {
      mockedDb.select.mockReturnValue({
        from: mockFrom([
          {
            id: "smithers-1",
            name: "Smithers",
            model: "anthropic/claude-sonnet-4-6",
            pluginConfig: null,
            allowedTools: ["pinchy_save_user_context"],
            ownerId: "user-1",
            isPersonal: true,
            createdAt: new Date(),
          },
        ]),
      } as never);

      await regenerateOpenClawConfig();

      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);

      expect(config.plugins.entries["pinchy-audit"].config.apiBaseUrl).toBe("http://pinchy:7778");
      expect(config.plugins.entries["pinchy-context"].config.apiBaseUrl).toBe("http://pinchy:7778");
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });

  it("should include both pinchy-files and pinchy-context when agents use both", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-6",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context"],
          ownerId: "user-1",
          isPersonal: true,
          createdAt: new Date(),
        },
        {
          id: "kb-agent",
          name: "KB Agent",
          model: "anthropic/claude-sonnet-4-6",
          pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs/"] } },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          ownerId: null,
          isPersonal: false,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-files"]).toBeDefined();
    expect(config.plugins.entries["pinchy-context"]).toBeDefined();
  });

  it("should include both save tools for admin Smithers", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "admin-smithers",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-6",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context", "pinchy_save_org_context"],
          ownerId: "admin-1",
          isPersonal: true,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-context"].config.agents["admin-smithers"]).toEqual({
      tools: ["save_user_context", "save_org_context"],
      userId: "admin-1",
    });
  });

  it("should include ollama-cloud provider config when ollama_cloud_api_key is set", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-test";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models).toBeDefined();
    expect(config.models.providers["ollama-cloud"]).toBeDefined();
    expect(config.models.providers["ollama-cloud"].baseUrl).toBe("https://ollama.com/v1");
    expect(config.models.providers["ollama-cloud"].apiKey).toEqual({
      source: "file",
      provider: "pinchy",
      id: "/providers/ollama-cloud/apiKey",
    });
    expect(config.models.providers["ollama-cloud"].api).toBe("openai-completions");
    expect(Array.isArray(config.models.providers["ollama-cloud"].models)).toBe(true);
    expect(config.models.providers["ollama-cloud"].models.length).toBeGreaterThan(0);
  });

  it("writes every tool-capable Ollama Cloud model into the config", async () => {
    // OpenClaw reads this list to know which cloud models exist and how to
    // prune their context. A mismatch between what Pinchy's UI lets the
    // admin pick and what OpenClaw knows about means the agent would run
    // with default context hints (or refuse the model entirely). Keep the
    // lists locked.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-test";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const modelIds = (config.models.providers["ollama-cloud"].models as Array<{ id: string }>).map(
      (m) => m.id
    );

    expect(modelIds.sort()).toEqual(
      [
        "deepseek-v3.1:671b",
        "deepseek-v3.2",
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        "devstral-2:123b",
        "devstral-small-2:24b",
        "gemini-3-flash-preview",
        "gemma4:31b",
        "glm-4.6",
        "glm-4.7",
        "glm-5",
        "glm-5.1",
        "gpt-oss:120b",
        "gpt-oss:20b",
        "kimi-k2-thinking",
        "kimi-k2.5",
        "kimi-k2.6",
        "minimax-m2",
        "minimax-m2.1",
        "minimax-m2.5",
        "minimax-m2.7",
        "ministral-3:14b",
        "ministral-3:3b",
        "ministral-3:8b",
        "mistral-large-3:675b",
        "nemotron-3-nano:30b",
        "nemotron-3-super",
        "qwen3-coder-next",
        "qwen3-coder:480b",
        "qwen3-next:80b",
        "qwen3-vl:235b",
        "qwen3-vl:235b-instruct",
        "qwen3.5:397b",
        "rnj-1:8b",
      ].sort()
    );
  });

  it("writes the correct context window for each Ollama Cloud model", async () => {
    // Context windows are taken from each model's ollama.com/library/<name>
    // page. Pinchy must not exceed the real limit (Ollama would reject the
    // request) and shouldn't under-report either (unnecessary compaction).
    // Ollama's "NK" convention is N * 1024, which we preserve here.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-test";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const models = config.models.providers["ollama-cloud"].models as Array<{
      id: string;
      contextWindow: number;
    }>;
    const ctx = Object.fromEntries(models.map((m) => [m.id, m.contextWindow]));

    // 32K — smallest in the list, was previously over-reported as 128K
    expect(ctx["rnj-1:8b"]).toBe(32768);
    // 128K
    expect(ctx["gpt-oss:20b"]).toBe(131072);
    expect(ctx["gpt-oss:120b"]).toBe(131072);
    // 160K
    expect(ctx["deepseek-v3.1:671b"]).toBe(163840);
    expect(ctx["deepseek-v3.2"]).toBe(163840);
    // 198K (GLM family, minimax-m2.5)
    expect(ctx["glm-4.6"]).toBe(202752);
    expect(ctx["glm-4.7"]).toBe(202752);
    expect(ctx["glm-5"]).toBe(202752);
    expect(ctx["glm-5.1"]).toBe(202752);
    expect(ctx["minimax-m2.5"]).toBe(202752);
    // 200K (other minimax variants)
    expect(ctx["minimax-m2"]).toBe(204800);
    expect(ctx["minimax-m2.1"]).toBe(204800);
    expect(ctx["minimax-m2.7"]).toBe(204800);
    // 256K — the most common class
    expect(ctx["devstral-2:123b"]).toBe(262144);
    expect(ctx["gemma4:31b"]).toBe(262144);
    expect(ctx["kimi-k2-thinking"]).toBe(262144);
    expect(ctx["kimi-k2.5"]).toBe(262144);
    expect(ctx["kimi-k2.6"]).toBe(262144);
    expect(ctx["ministral-3:3b"]).toBe(262144);
    expect(ctx["ministral-3:8b"]).toBe(262144);
    expect(ctx["ministral-3:14b"]).toBe(262144);
    expect(ctx["mistral-large-3:675b"]).toBe(262144);
    expect(ctx["nemotron-3-super"]).toBe(262144);
    expect(ctx["qwen3-coder-next"]).toBe(262144);
    expect(ctx["qwen3-coder:480b"]).toBe(262144);
    expect(ctx["qwen3-next:80b"]).toBe(262144);
    expect(ctx["qwen3-vl:235b"]).toBe(262144);
    expect(ctx["qwen3-vl:235b-instruct"]).toBe(262144);
    expect(ctx["qwen3.5:397b"]).toBe(262144);
    // 384K
    expect(ctx["devstral-small-2:24b"]).toBe(393216);
    // 1M
    expect(ctx["deepseek-v4-flash"]).toBe(1048576);
    expect(ctx["deepseek-v4-pro"]).toBe(1048576);
    expect(ctx["gemini-3-flash-preview"]).toBe(1048576);
    expect(ctx["nemotron-3-nano:30b"]).toBe(1048576);
  });

  it("writes reasoning, input (vision), and cost fields for every Ollama Cloud model", async () => {
    // OpenClaw's ModelDefinitionConfig requires `reasoning`, `input`, and
    // `cost` alongside contextWindow/maxTokens/compat. Without these the
    // runtime falls back to silent defaults — vision-capable models get
    // treated as text-only, reasoning models can't advertise thinking, and
    // estimatedCostUsd stays 0 for every session. Verified per model on
    // ollama.com/library/<name>.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-test";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const models = config.models.providers["ollama-cloud"].models as Array<{
      id: string;
      reasoning?: boolean;
      input?: string[];
      cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    }>;
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));

    // Vision-capable cloud models per ollama.com/search?c=vision&c=cloud
    const visionModels = [
      "devstral-small-2:24b",
      "gemini-3-flash-preview",
      "gemma4:31b",
      "kimi-k2.5",
      "kimi-k2.6",
      "ministral-3:3b",
      "ministral-3:8b",
      "ministral-3:14b",
      "mistral-large-3:675b",
      "qwen3-vl:235b",
      "qwen3-vl:235b-instruct",
      "qwen3.5:397b",
    ];
    for (const id of visionModels) {
      expect(byId[id].input).toEqual(["text", "image"]);
    }
    // Spot-check that text-only models stay text-only (gemma4 was the
    // specific counter-example the user flagged during review)
    expect(byId["rnj-1:8b"].input).toEqual(["text"]);
    expect(byId["qwen3-coder:480b"].input).toEqual(["text"]);
    expect(byId["deepseek-v3.2"].input).toEqual(["text"]);

    // Reasoning-capable cloud models per ollama.com/search?c=thinking&c=cloud
    const reasoningModels = [
      "deepseek-v3.1:671b",
      "deepseek-v3.2",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gemini-3-flash-preview",
      "gemma4:31b",
      "glm-4.6",
      "glm-4.7",
      "glm-5",
      "glm-5.1",
      "gpt-oss:20b",
      "gpt-oss:120b",
      "kimi-k2-thinking",
      "kimi-k2.5",
      "kimi-k2.6",
      "minimax-m2",
      "minimax-m2.5",
      "minimax-m2.7",
      "nemotron-3-nano:30b",
      "nemotron-3-super",
      "qwen3-next:80b",
      "qwen3-vl:235b",
      "qwen3-vl:235b-instruct",
      "qwen3.5:397b",
    ];
    for (const id of reasoningModels) {
      expect(byId[id].reasoning).toBe(true);
    }
    // Non-reasoning — qwen3-coder-next explicitly "Non-thinking mode only",
    // ministral-3 / mistral-large-3 / devstral-* and rnj-1 not tagged,
    // minimax-m2.1 absent from Ollama's thinking tag list.
    const nonReasoningModels = [
      "devstral-2:123b",
      "devstral-small-2:24b",
      "minimax-m2.1",
      "ministral-3:3b",
      "ministral-3:8b",
      "ministral-3:14b",
      "mistral-large-3:675b",
      "qwen3-coder-next",
      "qwen3-coder:480b",
      "rnj-1:8b",
    ];
    for (const id of nonReasoningModels) {
      expect(byId[id].reasoning).toBe(false);
    }

    // Ollama Cloud uses subscription pricing, not per-token billing (see
    // ollama.com/pricing). Setting cost to zero is the honest value — a
    // fabricated per-token rate would make the Usage dashboard lie about
    // spend for users on the Free / Pro / Max plans.
    for (const model of models) {
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });

  it("opts every Ollama Cloud model into streaming usage reporting", async () => {
    // Ollama Cloud's /v1/chat/completions only emits a final `usage` chunk
    // when the request carries `stream_options: { include_usage: true }`.
    // OpenClaw adds that flag only when the model config opts in via
    // `compat.supportsUsageInStreaming: true` — its own auto-detection
    // treats configured non-OpenAI endpoints as "not supported" by default.
    // Without this opt-in, sessions have no inputTokens/outputTokens, the
    // poller records nothing, and Usage & Costs stays empty.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-test";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const models = config.models.providers["ollama-cloud"].models as Array<{
      id: string;
      compat?: { supportsUsageInStreaming?: boolean };
    }>;

    for (const model of models) {
      expect(model.compat?.supportsUsageInStreaming).toBe(true);
    }
  });

  it("should not include models block when neither ollama provider is configured", async () => {
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models).toBeUndefined();
  });

  it("should include local ollama provider config when ollama_local_url is set", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama"]).toBeDefined();
    expect(config.models.providers["ollama"].baseUrl).toBe("http://host.docker.internal:11434");
    expect(config.models.providers["ollama"].api).toBe("ollama");
    expect(config.models.providers["ollama"].models).toEqual([]);
  });

  it("should include both ollama providers when both are configured", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-cloud";
      if (key === "ollama_local_url") return "http://localhost:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama-cloud"]).toBeDefined();
    expect(config.models.providers["ollama"]).toBeDefined();
  });

  it("should strip trailing slash from ollama local URL", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434/";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama"].baseUrl).toBe("http://host.docker.internal:11434");
  });

  it("should not add env block for ollama-local provider (URL-based, no API key)", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // ollama-local is URL-based — no env block and no models.providers.anthropic
    expect(config.env).toBeUndefined();
    expect(config?.models?.providers?.anthropic).toBeUndefined();
  });

  it("should omit pinchy-context and pinchy-files when no agents use them", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "custom-agent-id",
          name: "Dev Assistant",
          model: "anthropic/claude-opus-4-7",
          templateId: "custom",
          pluginConfig: null,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // Unused plugins are omitted from entries AND allow list to prevent
    // auto-discovery (restart loop) and "disabled but config present" spam
    expect(config.plugins.entries["pinchy-context"]).toBeUndefined();
    expect(config.plugins.entries["pinchy-files"]).toBeUndefined();
    expect(config.plugins.entries["pinchy-docs"]).toBeUndefined();
    expect(config.plugins.allow).not.toContain("pinchy-context");
    expect(config.plugins.allow).not.toContain("pinchy-files");
    expect(config.plugins.allow).not.toContain("pinchy-docs");
    // pinchy-audit is always enabled to capture tool usage at source
    expect(config.plugins.entries["pinchy-audit"].enabled).toBe(true);
    expect(config.plugins.allow).toContain("pinchy-audit");
  });

  it("strips stale pinchy-* plugins from allow list when they have no entries", async () => {
    // Simulate a config that was written before some plugins were removed —
    // e.g. pinchy-files and pinchy-odoo are in allow but no agent uses them.
    // OpenClaw rejects plugins in allow without valid config, so we must clean up.
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan", auth: { mode: "token", token: "tok" } },
        plugins: {
          allow: ["pinchy-files", "pinchy-context", "pinchy-audit", "pinchy-odoo", "telegram"],
          entries: {},
        },
      })
    );

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Dev",
          model: "anthropic/claude-opus-4-7",
          templateId: "custom",
          pluginConfig: null,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // pinchy-files and pinchy-odoo have no entries → must be removed from allow
    expect(config.plugins.allow).not.toContain("pinchy-files");
    expect(config.plugins.allow).not.toContain("pinchy-odoo");
    // Non-pinchy plugins (OpenClaw-managed) must be preserved
    expect(config.plugins.allow).toContain("telegram");
    // pinchy-audit is always enabled
    expect(config.plugins.allow).toContain("pinchy-audit");
  });

  it("enables pinchy-docs plugin with personal agent ids when personal agents exist", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          isPersonal: true,
          ownerId: "user-1",
          allowedTools: ["pinchy_save_user_context"],
          createdAt: new Date(),
        },
        {
          id: "shared-1",
          name: "Shared",
          model: "anthropic/claude-haiku-4-5-20251001",
          isPersonal: false,
          ownerId: null,
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-docs"]).toBeDefined();
    expect(config.plugins.entries["pinchy-docs"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-docs"].config.docsPath).toBe("/pinchy-docs");
    expect(config.plugins.entries["pinchy-docs"].config.agents).toEqual({
      "smithers-1": {},
    });
    expect(config.plugins.allow).toContain("pinchy-docs");
  });

  it("writes per-agent auth-profiles.json scoped to each agent's model provider", async () => {
    const agentsData = [
      {
        id: "agent-alpha",
        name: "Smithers",
        model: "anthropic/claude-sonnet-4-6",
        allowedTools: [],
        pluginConfig: null,
        createdAt: new Date(),
      },
      {
        id: "agent-beta",
        name: "Jeeves",
        model: "openai/gpt-5.4",
        allowedTools: [],
        pluginConfig: null,
        createdAt: new Date(),
      },
    ];
    mockedDb.select.mockReturnValue({
      from: mockFrom(agentsData),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test";
      if (key === "openai_api_key") return "sk-openai-test";
      return null;
    });

    await regenerateOpenClawConfig();

    // auth-profiles.json is written atomically via writeFileSync → renameSync.
    // CONFIG_PATH is /openclaw-config/openclaw.json so configRoot = /openclaw-config.
    const authProfileCalls = mockedWriteFileSync.mock.calls.filter((call) =>
      String(call[0]).includes("auth-profiles.json")
    );
    expect(authProfileCalls.length).toBe(2);

    // agent-alpha uses anthropic model → only anthropic-default profile
    const alphaCall = authProfileCalls.find((call) => String(call[0]).includes("agent-alpha"))!;
    expect(alphaCall).toBeDefined();
    const alphaContent = JSON.parse(String(alphaCall[1]));
    expect(Object.keys(alphaContent.profiles)).toEqual(["anthropic-default"]);
    expect(Object.keys(alphaContent.profiles)).not.toContain("openai-default");

    // agent-beta uses openai model → only openai-default profile
    const betaCall = authProfileCalls.find((call) => String(call[0]).includes("agent-beta"))!;
    expect(betaCall).toBeDefined();
    const betaContent = JSON.parse(String(betaCall[1]));
    expect(Object.keys(betaContent.profiles)).toEqual(["openai-default"]);
    expect(Object.keys(betaContent.profiles)).not.toContain("anthropic-default");
  });

  it("does not write auth-profiles.json for ollama-local agents (URL-based, no API key)", async () => {
    const agentsData = [
      {
        id: "agent-llama",
        name: "Llama",
        model: "ollama/llama3.1:8b",
        allowedTools: [],
        pluginConfig: null,
        createdAt: new Date(),
      },
    ];
    mockedDb.select.mockReturnValue({
      from: mockFrom(agentsData),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test";
      return null;
    });

    await regenerateOpenClawConfig();

    // unlinkSync is called (not writeFileSync) because providers=[]; the mock
    // fs.unlinkSync is the real implementation (from actual fs mock) and will
    // throw ENOENT since the tmp dir doesn't exist — that error is swallowed.
    // What matters: no auth-profiles.json writeFileSync call for this agent.
    const authProfileCalls = mockedWriteFileSync.mock.calls.filter((call) =>
      String(call[0]).includes("auth-profiles.json")
    );
    expect(authProfileCalls.length).toBe(0);
  });

  it("retries readExistingConfig after 300 ms when it returns empty (EACCES/transient race)", async () => {
    // Scenario: OpenClaw's in-process SIGUSR1 restart rewrites openclaw.json
    // as root:0600 before start-openclaw.sh's chmod loop restores 0666.
    // Under CI load the chmod may not run within readExistingConfig()'s
    // 5×100ms budget → returns {} → meta absent → config.apply sends
    // meta-less payload → OpenClaw 4.27 "missing-meta-before-write" anomaly
    // → sentinel restoration broken → spurious full gateway restart (#193).
    // The fix is a single 300ms async retry: if the first read returns empty,
    // wait one chmod-loop tick and try again.
    vi.useFakeTimers();
    try {
      let configReadCount = 0;
      const existingWithMeta = {
        gateway: { mode: "local", bind: "lan", auth: { token: "tok-eacces-retry" } },
        meta: { version: "4.27.0", generatedAt: "2025-01-01T00:00:00Z" },
      };
      mockedReadFileSync.mockImplementation((path) => {
        if (String(path).includes("openclaw.json")) {
          configReadCount++;
          if (configReadCount === 1) {
            // Simulate readExistingConfig() returning {} (ENOENT or exhausted EACCES retries)
            throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
          }
          // Retry (count 2) and later file-comparison read (count 3+): return valid config
          return JSON.stringify(existingWithMeta);
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const promise = regenerateOpenClawConfig();
      await vi.advanceTimersByTimeAsync(300);
      await promise;

      const openclaw = mockedWriteFileSync.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
      );
      expect(openclaw).toBeDefined();
      const config = JSON.parse(openclaw![1] as string);
      // meta must be preserved from the retry read, not absent due to empty first read
      expect(config.meta).toEqual({ version: "4.27.0", generatedAt: "2025-01-01T00:00:00Z" });
    } finally {
      vi.useRealTimers();
    }
  });

  describe("config propagation to OpenClaw runtime (#200)", () => {
    // Pinchy must push config changes to OpenClaw's *runtime*, not just
    // disk. The original bug: writing openclaw.json relied on OpenClaw's
    // internal inotify watcher, which on production volumes had ~60 s of
    // pickup latency. Users sending messages right after creating an
    // agent saw `unknown agent id "<uuid>"` because the runtime didn't
    // yet know the agent. The fix is twofold:
    //  1. Always write the file synchronously so the slow inotify path is
    //     guaranteed to eventually pick it up.
    //  2. Trigger a fire-and-forget `config.apply` RPC for faster runtime
    //     propagation when the WS is connected. Fire-and-forget keeps POST
    //     /api/agents (and any other regenerate caller) responsive even
    //     when the apply itself blocks on a gateway restart (10–30 s).

    it("writes the config file synchronously regardless of OpenClaw connection state", async () => {
      // Default beforeEach has mockGetClient throwing — cold start path.
      await regenerateOpenClawConfig();
      expect(mockedWriteFileSync).toHaveBeenCalled();

      vi.clearAllMocks();

      // Now the connected path.
      mockConfigGet.mockResolvedValue({ hash: "abc123" });
      mockConfigApply.mockResolvedValue(undefined);
      mockGetClient.mockReturnValue({
        config: { get: mockConfigGet, apply: mockConfigApply },
      });
      await regenerateOpenClawConfig();
      expect(mockedWriteFileSync).toHaveBeenCalled();
    });

    it("triggers the background RPC push when the OpenClaw client is connected", async () => {
      mockConfigGet.mockResolvedValue({ hash: "abc123" });
      mockConfigApply.mockResolvedValue(undefined);
      mockGetClient.mockReturnValue({
        config: { get: mockConfigGet, apply: mockConfigApply },
      });

      await regenerateOpenClawConfig();

      // The push is fire-and-forget — wait for the background coroutine
      // to reach config.apply rather than spinning on real time, then
      // drain the remaining continuation so it doesn't bleed into the
      // next test (see drainBackgroundCoroutine docs).
      await vi.waitFor(() => expect(mockConfigApply).toHaveBeenCalledOnce());
      await drainBackgroundCoroutine();

      expect(mockConfigApply).toHaveBeenCalledOnce();
      const applyArgs = mockConfigApply.mock.calls[0];
      expect(applyArgs[0]).toContain('"agents"'); // raw config JSON
      expect(applyArgs[1]).toBe("abc123"); // baseHash
    });

    it("does not throw when the client is connected but config.apply fails", async () => {
      // Background apply errors must not bubble up. POST /api/agents must
      // succeed even if the runtime push can't be delivered — inotify
      // remains the safety net.
      mockConfigGet.mockRejectedValue(new Error("Not connected to OpenClaw Gateway"));
      mockGetClient.mockReturnValue({
        config: { get: mockConfigGet, apply: mockConfigApply },
      });

      await expect(regenerateOpenClawConfig()).resolves.not.toThrow();
      expect(mockedWriteFileSync).toHaveBeenCalled();
    });

    it("does not call config.apply at cold start before the OpenClaw client is initialised", async () => {
      // beforeEach sets mockGetClient to throw — exercises the no-client
      // path. We must still write the file (verified above) but must NOT
      // attempt the RPC.
      await regenerateOpenClawConfig();
      // Background coroutine bails immediately when client unavailable;
      // drain to confirm no microtask-deferred RPC slipped through.
      await drainBackgroundCoroutine();

      expect(mockConfigGet).not.toHaveBeenCalled();
      expect(mockConfigApply).not.toHaveBeenCalled();
    });

    it("supplements meta from file when OC in-memory config lacks it (post-restart race)", async () => {
      // Scenario: OC has just restarted and config.get() returns an in-memory
      // config that has not yet had meta stamped (missing-meta-before-write
      // anomaly). The file from the PREVIOUS run still has meta. The fallback
      // must pick it up so config.apply doesn't trigger a cascade restart.
      const ocConfigWithoutMeta = {
        gateway: { mode: "local" },
        plugins: { allow: ["anthropic"], entries: { anthropic: { enabled: true } } },
      };
      mockConfigGet.mockResolvedValue({ hash: "h1", config: ocConfigWithoutMeta });
      mockConfigApply.mockResolvedValue(undefined);
      mockGetClient.mockReturnValue({
        config: { get: mockConfigGet, apply: mockConfigApply },
      });
      // File from previous run has meta
      const metaBlock = { version: "4.27.0", lastTouchedAt: "2025-01-01T00:00:00Z" };
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          meta: metaBlock,
          gateway: { mode: "local" },
        }) as unknown as Buffer
      );

      await regenerateOpenClawConfig();
      await vi.waitFor(() => expect(mockConfigApply).toHaveBeenCalledOnce());
      await drainBackgroundCoroutine();

      const appliedPayload = JSON.parse(String(mockConfigApply.mock.calls[0][0]));
      expect(appliedPayload.meta).toEqual(metaBlock);
    });

    it("cancels pending retries when a newer pushConfigInBackground call starts", async () => {
      // Scenario: two pushConfigInBackground calls start back-to-back.
      // Only the SECOND (newer) call's payload must reach OpenClaw —
      // the first call must be cancelled by the generation counter before
      // it can fire config.apply with a stale payload.
      //
      // This prevents the production race where a slow-retry loop carrying
      // env.ANTHROPIC_API_KEY (from an initial setup call) fires simultaneously
      // with a later agents-only call, triggering a spurious restart (#193).
      mockConfigGet.mockResolvedValue({ hash: "h1" });
      mockConfigApply.mockResolvedValue(undefined); // always succeeds
      mockGetClient.mockImplementation(() => ({
        config: { get: mockConfigGet, apply: mockConfigApply },
      }));

      // Start first push with "old" payload.
      pushConfigInBackground(JSON.stringify({ env: { OLD: "1" } }));
      // Immediately start second push with "new" payload — increments the
      // generation counter, cancelling the first call's retry loop.
      pushConfigInBackground(JSON.stringify({ env: { NEW: "2" } }));

      // With the static import (no await import()), the OLD IIFE exits
      // synchronously at the generation check (1 ≠ 2 → return). The NEW
      // IIFE runs synchronously to its first real await (config.get()).
      // One drain round is enough to let config.get + config.apply settle.
      await drainBackgroundCoroutine();

      // Exactly ONE config.apply call — the first call was cancelled before
      // it could reach apply.
      expect(mockConfigApply).toHaveBeenCalledTimes(1);

      // Exactly ONE config.apply call — the first call was cancelled before
      // it could reach apply.
      expect(mockConfigApply).toHaveBeenCalledTimes(1);
      const appliedPayload = String(mockConfigApply.mock.calls[0][0]);
      expect(appliedPayload).toContain('"NEW"');
      expect(appliedPayload).not.toContain('"OLD"');
    });

    it("supplements channels.telegram fields absent from payload from OC in-memory config (OC 4.27+ channel diff prevention)", async () => {
      // OC 4.27 writes additional fields to channels.telegram in-memory
      // (e.g. pollingMode, or other new OC-managed fields). Pinchy's payload
      // omits these fields. Without supplement, config.apply sees a channels
      // diff → full gateway restart even for agents-only changes.
      const ocConfig = {
        meta: { version: "4.27.0", lastTouchedAt: "2025-01-01T00:00:00Z" },
        channels: {
          telegram: {
            enabled: true,
            dmPolicy: "pairing",
            accounts: { a1: { botToken: "tok" } },
            pollingMode: "long_poll", // OC-managed field Pinchy doesn't emit
          },
        },
      };
      mockConfigGet.mockResolvedValue({ hash: "h1", config: ocConfig });
      mockConfigApply.mockResolvedValue(undefined);
      mockGetClient.mockReturnValue({
        config: { get: mockConfigGet, apply: mockConfigApply },
      });

      // Pinchy's payload has channels.telegram WITHOUT pollingMode
      const pinchyPayload = JSON.stringify({
        meta: { version: "4.27.0" },
        channels: {
          telegram: {
            enabled: true,
            dmPolicy: "pairing",
            accounts: { a1: { botToken: "tok" } },
          },
        },
      });

      pushConfigInBackground(pinchyPayload);
      await vi.waitFor(() => expect(mockConfigApply).toHaveBeenCalledOnce());

      const applied = JSON.parse(String(mockConfigApply.mock.calls[0][0]));
      expect(applied.channels?.telegram?.pollingMode).toBe("long_poll");
    });

    it("skips config.apply when OC in-memory config and file both lack meta (missing-meta-before-write cascade guard)", async () => {
      // Scenario: OC just restarted (in-memory config has no meta) AND the
      // previous config.apply already wrote a meta-less file. Neither source
      // can supply meta, so supplementation leaves the payload without it.
      // Sending that payload via config.apply triggers OC's
      // "missing-meta-before-write" anomaly → SIGUSR1 restart cascade.
      //
      // The guard must detect this and return early, relying on inotify
      // (from the writeConfigAtomic call above) instead of config.apply.
      // The guard only fires when current.config IS defined (OC is running
      // and has a config) — cold-start (current.config absent) still proceeds.
      const ocConfigWithoutMeta = {
        gateway: { mode: "local" },
        plugins: { allow: ["anthropic"], entries: { anthropic: { enabled: true } } },
      };
      mockConfigGet.mockResolvedValue({ hash: "h1", config: ocConfigWithoutMeta });
      mockConfigApply.mockResolvedValue(undefined);
      mockGetClient.mockReturnValue({
        config: { get: mockConfigGet, apply: mockConfigApply },
      });
      // File also has no meta (written by a previous meta-less config.apply)
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          gateway: { mode: "local" },
        }) as unknown as Buffer
      );

      await regenerateOpenClawConfig();
      await drainBackgroundCoroutine();

      // config.apply must NOT be called — guard returns early when payload lacks meta
      expect(mockConfigApply).not.toHaveBeenCalled();
    });
  });
});

describe("sanitizeOpenClawConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("removes stale pinchy-* plugins from allow that have no entries", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local" },
        plugins: {
          allow: ["pinchy-files", "pinchy-audit", "pinchy-odoo", "telegram"],
          entries: {
            "pinchy-audit": { enabled: true, config: {} },
          },
        },
      })
    );

    const changed = sanitizeOpenClawConfig();

    expect(changed).toBe(true);
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written.plugins.allow).toContain("pinchy-audit");
    expect(written.plugins.allow).toContain("telegram");
    expect(written.plugins.allow).not.toContain("pinchy-files");
    expect(written.plugins.allow).not.toContain("pinchy-odoo");
  });

  it("returns false and does not write when allow list is already clean", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local" },
        plugins: {
          allow: ["pinchy-audit", "telegram"],
          entries: {
            "pinchy-audit": { enabled: true, config: {} },
          },
        },
      })
    );

    const changed = sanitizeOpenClawConfig();

    expect(changed).toBe(false);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("returns false when config file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);

    const changed = sanitizeOpenClawConfig();

    expect(changed).toBe(false);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("pinchy-web config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedGetSetting.mockResolvedValue(null);
  });

  it("should include pinchy-web entry when web-search connection exists and agent has web tools", async () => {
    const agentsData = [
      {
        id: "web-agent",
        name: "Web Agent",
        model: "anthropic/claude-sonnet-4-6",
        allowedTools: ["pinchy_web_search", "pinchy_web_fetch"],
        pluginConfig: {
          "pinchy-web": {
            allowedDomains: ["docs.example.com"],
            language: "de",
            country: "at",
            freshness: "month",
          },
        },
        createdAt: new Date(),
      },
    ];

    const webSearchConnections = [
      {
        id: "ws-conn-1",
        type: "web-search",
        name: "Brave Search",
        description: "",
        credentials: JSON.stringify({ apiKey: "BSA-test-key" }),
        data: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // agents table
          return Object.assign(Promise.resolve(agentsData), {
            innerJoin: mockInnerJoin([]),
          });
        }
        // callCount 2 = agentConnectionPermissions (chained with innerJoin)
        // callCount 3 = integrationConnections for web-search (with where)
        if (callCount === 3) {
          return Object.assign(Promise.resolve(webSearchConnections), {
            innerJoin: mockInnerJoin([]),
            where: vi.fn().mockResolvedValue(webSearchConnections),
          });
        }
        return Object.assign(Promise.resolve([]), {
          innerJoin: mockInnerJoin([]),
          where: vi.fn().mockResolvedValue([]),
        });
      }),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-web"]).toBeDefined();
    expect(config.plugins.entries["pinchy-web"].enabled).toBe(true);
    // braveApiKey is fetched on demand via the credentials API — not in config (#209)
    expect(config.plugins.entries["pinchy-web"].config.braveApiKey).toBeUndefined();
    expect(config.plugins.entries["pinchy-web"].config.connectionId).toBe("ws-conn-1");
    expect(typeof config.plugins.entries["pinchy-web"].config.apiBaseUrl).toBe("string");
    expect(typeof config.plugins.entries["pinchy-web"].config.gatewayToken).toBe("string");
    expect(config.plugins.entries["pinchy-web"].config.agents["web-agent"]).toEqual({
      tools: ["pinchy_web_search", "pinchy_web_fetch"],
      allowedDomains: ["docs.example.com"],
      language: "de",
      country: "at",
      freshness: "month",
    });
    expect(config.plugins.allow).toContain("pinchy-web");
  });

  it("should not include pinchy-web when no web-search connection exists", async () => {
    const agentsData = [
      {
        id: "web-agent",
        name: "Web Agent",
        model: "anthropic/claude-sonnet-4-6",
        allowedTools: ["pinchy_web_search"],
        pluginConfig: null,
        createdAt: new Date(),
      },
    ];

    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Object.assign(Promise.resolve(agentsData), {
            innerJoin: mockInnerJoin([]),
          });
        }
        // No web-search connections returned
        return Object.assign(Promise.resolve([]), {
          innerJoin: mockInnerJoin([]),
          where: vi.fn().mockResolvedValue([]),
        });
      }),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-web"]).toBeUndefined();
  });

  it("should not include pinchy-web when connection exists but no agent has web tools", async () => {
    const agentsData = [
      {
        id: "plain-agent",
        name: "Plain Agent",
        model: "anthropic/claude-sonnet-4-6",
        allowedTools: ["pinchy_ls", "pinchy_read"],
        pluginConfig: { "pinchy-files": { allowed_paths: ["/data/docs/"] } },
        createdAt: new Date(),
      },
    ];

    const webSearchConnections = [
      {
        id: "ws-conn-1",
        type: "web-search",
        name: "Brave Search",
        description: "",
        credentials: JSON.stringify({ apiKey: "BSA-key" }),
        data: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Object.assign(Promise.resolve(agentsData), {
            innerJoin: mockInnerJoin([]),
          });
        }
        if (callCount === 3) {
          return Object.assign(Promise.resolve(webSearchConnections), {
            innerJoin: mockInnerJoin([]),
            where: vi.fn().mockResolvedValue(webSearchConnections),
          });
        }
        return Object.assign(Promise.resolve([]), {
          innerJoin: mockInnerJoin([]),
          where: vi.fn().mockResolvedValue([]),
        });
      }),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-web"]).toBeUndefined();
  });

  it("should only list pinchy_web_search when agent does not have pinchy_web_fetch", async () => {
    const agentsData = [
      {
        id: "search-only-agent",
        name: "Search Only",
        model: "anthropic/claude-sonnet-4-6",
        allowedTools: ["pinchy_web_search"],
        pluginConfig: null,
        createdAt: new Date(),
      },
    ];

    const webSearchConnections = [
      {
        id: "ws-conn-1",
        type: "web-search",
        name: "Brave Search",
        description: "",
        credentials: JSON.stringify({ apiKey: "BSA-key" }),
        data: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Object.assign(Promise.resolve(agentsData), {
            innerJoin: mockInnerJoin([]),
          });
        }
        if (callCount === 3) {
          return Object.assign(Promise.resolve(webSearchConnections), {
            innerJoin: mockInnerJoin([]),
            where: vi.fn().mockResolvedValue(webSearchConnections),
          });
        }
        return Object.assign(Promise.resolve([]), {
          innerJoin: mockInnerJoin([]),
          where: vi.fn().mockResolvedValue([]),
        });
      }),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-web"]).toBeDefined();
    expect(config.plugins.entries["pinchy-web"].config.agents["search-only-agent"].tools).toEqual([
      "pinchy_web_search",
    ]);
  });

  it("should pass through pluginConfig filter settings alongside tools", async () => {
    const agentsData = [
      {
        id: "filtered-agent",
        name: "Filtered Agent",
        model: "anthropic/claude-sonnet-4-6",
        allowedTools: ["pinchy_web_search", "pinchy_web_fetch"],
        pluginConfig: {
          "pinchy-web": {
            allowedDomains: ["example.com", "docs.example.com"],
            excludedDomains: ["evil.com"],
            language: "en",
            country: "us",
            freshness: "week",
          },
        },
        createdAt: new Date(),
      },
    ];

    const webSearchConnections = [
      {
        id: "ws-conn-1",
        type: "web-search",
        name: "Brave Search",
        description: "",
        credentials: JSON.stringify({ apiKey: "BSA-filter-key" }),
        data: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Object.assign(Promise.resolve(agentsData), {
            innerJoin: mockInnerJoin([]),
          });
        }
        if (callCount === 3) {
          return Object.assign(Promise.resolve(webSearchConnections), {
            innerJoin: mockInnerJoin([]),
            where: vi.fn().mockResolvedValue(webSearchConnections),
          });
        }
        return Object.assign(Promise.resolve([]), {
          innerJoin: mockInnerJoin([]),
          where: vi.fn().mockResolvedValue([]),
        });
      }),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const agentConfig = config.plugins.entries["pinchy-web"].config.agents["filtered-agent"];
    expect(agentConfig).toEqual({
      tools: ["pinchy_web_search", "pinchy_web_fetch"],
      allowedDomains: ["example.com", "docs.example.com"],
      excludedDomains: ["evil.com"],
      language: "en",
      country: "us",
      freshness: "week",
    });
  });
});

describe("pinchy-web: credentials fetched on demand via Pinchy API (#209)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedGetSetting.mockResolvedValue(null);
  });

  it("writes only connectionId + apiBaseUrl + gatewayToken — no braveApiKey in openclaw.json", async () => {
    const agentsData = [
      {
        id: "web-agent",
        name: "Web Agent",
        model: "anthropic/claude-sonnet-4-6",
        allowedTools: ["pinchy_web_search"],
        pluginConfig: null,
        createdAt: new Date(),
      },
    ];

    const webSearchConnections = [
      {
        id: "ws-conn-42",
        type: "web-search",
        name: "Brave Search",
        description: "",
        credentials: JSON.stringify({ apiKey: "BSA-secret-key" }),
        data: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Object.assign(Promise.resolve(agentsData), {
            innerJoin: mockInnerJoin([]),
          });
        }
        if (callCount === 3) {
          return Object.assign(Promise.resolve(webSearchConnections), {
            innerJoin: mockInnerJoin([]),
            where: vi.fn().mockResolvedValue(webSearchConnections),
          });
        }
        return Object.assign(Promise.resolve([]), {
          innerJoin: mockInnerJoin([]),
          where: vi.fn().mockResolvedValue([]),
        });
      }),
    } as never);

    await regenerateOpenClawConfig();

    // openclaw.json must NOT contain the apiKey at all (#209): the plugin
    // fetches it on demand from /api/internal/integrations/<id>/credentials.
    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);

    const webPlugin = config.plugins.entries["pinchy-web"].config;
    expect(webPlugin.connectionId).toBe("ws-conn-42");
    expect(typeof webPlugin.apiBaseUrl).toBe("string");
    expect(typeof webPlugin.gatewayToken).toBe("string");
    // No braveApiKey, no SecretRef pointer.
    expect(webPlugin.braveApiKey).toBeUndefined();
    expect(written![1]).not.toContain("BSA-secret-key");
  });
});

describe("pinchy-odoo config size", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedGetSetting.mockResolvedValue(null);
  });

  it("should include only modelNames, not full schema with fields", async () => {
    const agentsData = [
      {
        id: "odoo-agent",
        name: "Odoo Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["odoo_read"],
        createdAt: new Date(),
      },
    ];

    const permissionsData = [
      {
        agent_connection_permissions: {
          agentId: "odoo-agent",
          connectionId: "conn-1",
          model: "sale.order",
          operation: "read",
        },
        integration_connections: {
          id: "conn-1",
          type: "odoo",
          name: "Test Odoo",
          description: "",
          credentials: JSON.stringify({
            url: "https://odoo.test",
            db: "test",
            uid: 2,
            apiKey: "key",
          }),
          data: {
            models: [
              {
                model: "sale.order",
                name: "Sales Orders",
                fields: [
                  { name: "id", string: "ID", type: "integer", required: true, readonly: true },
                ],
                access: { read: true, create: false, write: false, delete: false },
              },
              {
                model: "res.partner",
                name: "Contacts",
                fields: [
                  { name: "id", string: "ID", type: "integer", required: true, readonly: true },
                ],
                access: { read: true, create: true, write: true, delete: false },
              },
            ],
            lastSyncAt: "2026-04-01T00:00:00Z",
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: mockInnerJoin(permissionsData),
          where: vi.fn().mockResolvedValue([]),
        })
      ),
    } as never);

    await regenerateOpenClawConfig();

    const writtenCall = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(writtenCall).toBeDefined();
    const config = JSON.parse(writtenCall![1] as string);

    const odooConfig = config.plugins?.entries?.["pinchy-odoo"]?.config?.agents?.["odoo-agent"];
    expect(odooConfig).toBeDefined();

    // Should have modelNames (lightweight)
    expect(odooConfig.modelNames).toEqual({ "sale.order": "Sales Orders" });

    // Should NOT have full schema with fields
    expect(odooConfig.schema).toBeUndefined();

    // Config should be small (no field definitions bloating it)
    const configSize = writtenCall![1]!.toString().length;
    expect(configSize).toBeLessThan(5000); // Without schema: ~2-3KB. With schema it would be 100KB+
  });

  it("does not decrypt Odoo connection credentials at config-write time", async () => {
    // Since #209: credential decryption happens lazily in the
    // /api/internal/integrations/:id/credentials endpoint when the plugin
    // asks for credentials — never in regenerateOpenClawConfig itself.
    // This means ENCRYPTION_KEY rotation does NOT brick the openclaw.json
    // generation: the config still gets the connectionId, and only the
    // first plugin tool call surfaces the decryption error to the user.
    const agentsData = [
      {
        id: "odoo-agent",
        name: "Odoo Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["odoo_read"],
        createdAt: new Date(),
      },
    ];

    const permissionsData = [
      {
        agent_connection_permissions: {
          agentId: "odoo-agent",
          connectionId: "conn-odoo",
          model: "sale.order",
          operation: "read",
        },
        integration_connections: {
          id: "conn-odoo",
          type: "odoo",
          name: "Some Odoo",
          description: "",
          credentials: "POISONED_BY_KEY_ROTATION",
          data: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: mockInnerJoin(permissionsData),
          where: vi.fn().mockResolvedValue([]),
        })
      ),
    } as never);

    // Make decrypt throw to verify it is NOT called during config write.
    mockDecrypt.mockImplementation(() => {
      throw new Error("decrypt should never be called from openclaw-config for Odoo connections");
    });

    await expect(regenerateOpenClawConfig()).resolves.toBeUndefined();

    const writtenCall = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(writtenCall).toBeDefined();
    const config = JSON.parse(writtenCall![1] as string);
    const odooAgents = config.plugins?.entries?.["pinchy-odoo"]?.config?.agents ?? {};

    expect(odooAgents["odoo-agent"]).toBeDefined();
    expect(odooAgents["odoo-agent"].connectionId).toBe("conn-odoo");

    // Reset for subsequent tests
    mockDecrypt.mockImplementation((val: string) => val);
  });
});

describe("pinchy-odoo: credentials fetched on demand via Pinchy API (#209)", () => {
  // The previous design wrote `apiKey` as a SecretRef pointer
  // (`{ source: "file", provider: "pinchy", id: "..." }`) into
  // openclaw.json, intending OpenClaw to resolve it. OpenClaw 2026.4.x
  // does NOT resolve SecretRefs in arbitrary plugin config paths, so
  // the unresolved dict reached the Odoo plugin and was forwarded to
  // Odoo as the password — which crashed the Odoo Python server with
  // `unhashable type: 'dict'`.
  //
  // The new design follows pinchy-email: the plugin gets only an
  // opaque `connectionId` plus the gateway token, and fetches
  // credentials on demand from
  // `/api/internal/integrations/<id>/credentials`. openclaw.json no
  // longer carries any per-integration credential — secrets stay in
  // the encrypted DB, owned by Pinchy, with a single rotation/audit
  // surface.

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedGetSetting.mockResolvedValue(null);
  });

  it("writes only connectionId + apiBaseUrl + gatewayToken — no credentials in openclaw.json", async () => {
    const agentsData = [
      {
        id: "odoo-agent",
        name: "Odoo Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["odoo_read"],
        createdAt: new Date(),
      },
    ];

    const permissionsData = [
      {
        agent_connection_permissions: {
          agentId: "odoo-agent",
          connectionId: "conn-odoo-1",
          model: "sale.order",
          operation: "read",
        },
        integration_connections: {
          id: "conn-odoo-1",
          type: "odoo",
          name: "My Odoo",
          description: "Production Odoo",
          credentials: JSON.stringify({
            url: "https://odoo.example.com",
            db: "mydb",
            uid: 2,
            apiKey: "secret-odoo-key",
          }),
          data: { models: [], lastSyncAt: "2026-04-01T00:00:00Z" },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: mockInnerJoin(permissionsData),
          where: vi.fn().mockResolvedValue([]),
        })
      ),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);

    const odooPlugin = config.plugins?.entries?.["pinchy-odoo"]?.config;
    expect(odooPlugin).toBeDefined();
    // Plugin-level: apiBaseUrl + gatewayToken are present so the plugin
    // can reach Pinchy.
    expect(typeof odooPlugin.apiBaseUrl).toBe("string");
    expect(odooPlugin.apiBaseUrl).toContain("/");
    expect(typeof odooPlugin.gatewayToken).toBe("string");

    const odooAgent = odooPlugin.agents?.["odoo-agent"];
    expect(odooAgent).toBeDefined();
    expect(odooAgent.connectionId).toBe("conn-odoo-1");
    // Critical: no credentials at all in the agent config. No `connection`
    // object, no `apiKey`, no SecretRef pointer. The plugin will fetch
    // credentials from Pinchy on first tool call.
    expect(odooAgent.connection).toBeUndefined();
    expect(JSON.stringify(odooAgent)).not.toContain("secret-odoo-key");

    // The whole openclaw.json must not leak the apiKey under any path.
    expect(written![1]).not.toContain("secret-odoo-key");
  });
});

describe("restart-state integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedDb.select.mockReturnValue({
      from: mockFrom(),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
  });

  it("regenerateOpenClawConfig does not call restartState.notifyRestart (OpenClaw detects file changes)", async () => {
    const { restartState } = await import("@/server/restart-state");

    await regenerateOpenClawConfig();

    expect(restartState.notifyRestart).not.toHaveBeenCalled();
  });

  it("should skip writing and not restart when config content is unchanged", async () => {
    const { restartState } = await import("@/server/restart-state");

    // First call writes the config
    await regenerateOpenClawConfig();
    const firstWrite = mockedWriteFileSync.mock.calls[0][1] as string;

    vi.clearAllMocks();
    // Mock readFileSync to return what was just written
    mockedReadFileSync.mockReturnValue(firstWrite);
    mockedExistsSync.mockReturnValue(true);
    mockedDb.select.mockReturnValue({
      from: mockFrom(),
    } as never);
    mockedGetSetting.mockResolvedValue(null);

    // Second call should skip writing
    await regenerateOpenClawConfig();

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(restartState.notifyRestart).not.toHaveBeenCalled();
  });

  it("should include Telegram channel config with accounts format when bot token is configured", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-token";
      if (key === "telegram_bot_username:agent-1") return "acme_smithers_bot";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.channels.telegram).toEqual({
      dmPolicy: "pairing",
      enabled: true,
      accounts: {
        "agent-1": {
          botToken: "123456:ABC-token",
        },
      },
    });
    expect(config.bindings).toEqual([
      { agentId: "agent-1", match: { channel: "telegram", accountId: "agent-1" } },
    ]);
    expect(config.session.dmScope).toBe("per-peer");
  });

  it("should include multiple accounts when multiple agents have bots", async () => {
    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Object.assign(
            Promise.resolve([
              { id: "agent-1", name: "Smithers", model: "m", allowedTools: [] },
              { id: "agent-2", name: "Support", model: "m", allowedTools: [] },
            ]),
            { innerJoin: mockInnerJoin([]), where: vi.fn().mockResolvedValue([]) }
          );
        }
        return Object.assign(Promise.resolve([]), {
          innerJoin: mockInnerJoin([]),
          where: vi.fn().mockResolvedValue([]),
        });
      }),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "token-1";
      if (key === "telegram_bot_token:agent-2") return "token-2";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.channels.telegram.accounts).toEqual({
      "agent-1": { botToken: "token-1" },
      "agent-2": { botToken: "token-2" },
    });
    expect(config.bindings).toEqual([
      { agentId: "agent-1", match: { channel: "telegram", accountId: "agent-1" } },
      { agentId: "agent-2", match: { channel: "telegram", accountId: "agent-2" } },
    ]);
  });

  it("should generate per-user peer bindings for personal agents (Smithers)", async () => {
    // Personal agent (Smithers) with bot token: each linked user should get
    // a peer-specific binding routing to their OWN personal Smithers agent.
    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // agents table: admin's Smithers has the bot, plus user-b's Smithers
          return Object.assign(
            Promise.resolve([
              {
                id: "admin-smithers",
                name: "Smithers",
                model: "m",
                allowedTools: [],
                isPersonal: true,
                ownerId: "user-a",
              },
              {
                id: "user-b-smithers",
                name: "Smithers",
                model: "m",
                allowedTools: [],
                isPersonal: true,
                ownerId: "user-b",
              },
            ]),
            { innerJoin: mockInnerJoin([]), where: vi.fn().mockResolvedValue([]) }
          );
        }
        // callCount 2 = agentConnectionPermissions (chained with innerJoin)
        // callCount 3 = integrationConnections for web-search (chained with where)
        // callCount 4 = channel_links table: both users linked
        if (callCount === 4) {
          return Object.assign(
            Promise.resolve([
              { userId: "user-a", channel: "telegram", channelUserId: "111222333" },
              { userId: "user-b", channel: "telegram", channelUserId: "444555666" },
            ]),
            { innerJoin: mockInnerJoin([]), where: vi.fn().mockResolvedValue([]) }
          );
        }
        return Object.assign(Promise.resolve([]), {
          innerJoin: mockInnerJoin([]),
          where: vi.fn().mockResolvedValue([]),
        });
      }),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:admin-smithers") return "123456:ABC-token";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // One account for the bot
    expect(config.channels.telegram.accounts).toEqual({
      "admin-smithers": { botToken: "123456:ABC-token" },
    });

    // Per-user peer bindings: user-a → admin-smithers, user-b → user-b-smithers
    expect(config.bindings).toEqual(
      expect.arrayContaining([
        {
          agentId: "admin-smithers",
          match: {
            channel: "telegram",
            accountId: "admin-smithers",
            peer: { kind: "dm", id: "111222333" },
          },
        },
        {
          agentId: "user-b-smithers",
          match: {
            channel: "telegram",
            accountId: "admin-smithers",
            peer: { kind: "dm", id: "444555666" },
          },
        },
      ])
    );
    // No generic binding without peer (all users are routed via peer-specific bindings)
    const genericBinding = config.bindings.find(
      (b: Record<string, unknown>) => (b.match as Record<string, unknown>).peer === undefined
    );
    expect(genericBinding).toBeUndefined();
  });

  it("should not include Telegram config when no bot token is configured", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.channels).toBeUndefined();
    expect(config.bindings).toBeUndefined();
  });

  it("should include identityLinks from channel_links table", async () => {
    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: agents table
          return Object.assign(
            Promise.resolve([{ id: "agent-1", name: "Smithers", model: "m", allowedTools: [] }]),
            { innerJoin: mockInnerJoin([]), where: vi.fn().mockResolvedValue([]) }
          );
        }
        // callCount 2 = agentConnectionPermissions (chained with innerJoin)
        // callCount 3 = integrationConnections for web-search (chained with where)
        // callCount 4 = channel_links table
        if (callCount === 4) {
          return Object.assign(
            Promise.resolve([{ userId: "user-1", channel: "telegram", channelUserId: "999888" }]),
            { innerJoin: mockInnerJoin([]), where: vi.fn().mockResolvedValue([]) }
          );
        }
        return Object.assign(Promise.resolve([]), {
          innerJoin: mockInnerJoin([]),
          where: vi.fn().mockResolvedValue([]),
        });
      }),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "token";
      if (key === "telegram_bot_username:agent-1") return "bot";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.session.identityLinks).toEqual({
      "user-1": ["telegram:999888"],
    });
  });

  it("preserves all non-Pinchy-owned fields from existingTelegram on regenerate", async () => {
    // OC 4.27 writes new fields to channels.telegram that Pinchy doesn't know
    // about (e.g. pollingMode). Using an allowlist (like the old ENRICHED_TELEGRAM_FIELDS)
    // caused those fields to be stripped → channels diff on every config.apply →
    // spurious full gateway restart even for agents-only changes.
    // Using a denylist (preserve everything except Pinchy-owned fields) is
    // robust to future OC additions.
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "secret" } },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          groupPolicy: "allow",
          pollingMode: "long_poll", // OC 4.27-managed field
          accounts: {},
        },
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-token";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);

    // All non-Pinchy-owned fields from the existing file are preserved
    expect(config.channels.telegram.groupPolicy).toBe("allow");
    expect(config.channels.telegram.pollingMode).toBe("long_poll");
    // Pinchy-owned fields are written fresh (not taken from existing)
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.telegram.dmPolicy).toBe("pairing");
  });

  it("preserves channels.telegram.enabled when OpenClaw set it on auto-enable (#193)", async () => {
    // OpenClaw writes back `"enabled": true` whenever Telegram is auto-enabled
    // ("[gateway] auto-enabled plugins: Telegram configured, enabled
    // automatically"). If Pinchy strips this field on the next regenerate,
    // OpenClaw sees a config diff, fires another full gateway restart, the
    // restart auto-enables Telegram again and re-adds the field — endless
    // ping-pong loop where every settings save costs 15-30s of "Agent runtime
    // is not available" downtime.
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "secret" } },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          enabled: true,
          accounts: { "agent-1": { botToken: "123456:ABC-token" } },
        },
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-token";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);

    expect(config.channels.telegram.enabled).toBe(true);
  });

  it("writes channels.telegram.enabled=true on first generate when no existing config (#193)", async () => {
    // Defense in depth for the auto-enable ping-pong: don't depend on
    // OpenClaw's auto-enable side-effect to put `enabled: true` in the
    // file. Pinchy writes it actively whenever it emits a telegram block,
    // so the very first generate matches what OpenClaw expects after its
    // auto-enable step. Otherwise the cycle starts:
    //   write1 (no enabled) → restart → OpenClaw adds enabled → write2 strips
    //   it → restart → ... — exactly the staging cascade observed on
    //   2026-05-01.
    // mockedReadFileSync stays at default (throws ENOENT) — fresh config.

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-token";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);

    expect(config.channels.telegram.enabled).toBe(true);
  });

  it("preserves plugins.entries.<provider> auto-enabled by OpenClaw (#193)", async () => {
    // Same class of bug as channels.telegram.enabled: OpenClaw auto-enables
    // each configured provider and writes `plugins.entries.<provider> = { enabled: true }`
    // back to openclaw.json. If Pinchy strips this on the next regenerate,
    // OpenClaw sees a `plugins.entries.<provider>` diff and restarts the
    // gateway. Verified on local E2E stack 2026-05-01: a fresh `POST
    // /api/agents` restarted the gateway because of `plugins.entries.anthropic`.
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "secret" } },
      plugins: {
        allow: ["anthropic", "pinchy-audit"],
        entries: {
          anthropic: { enabled: true },
          "pinchy-audit": { enabled: true, config: {} },
        },
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-fake-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);

    // The OpenClaw-managed entry must survive the regenerate.
    expect(config.plugins.entries.anthropic).toEqual({ enabled: true });
  });

  it("preserves the order of plugins.allow from the existing config (#193 follow-up)", async () => {
    // OpenClaw's reload subsystem treats `plugins.allow` as a no-hot-reload
    // path: any diff there triggers a full gateway restart. The naive
    // "openClawPlugins ++ ourPlugins" composition produces a different order
    // than what OpenClaw writes back after auto-enable (typically
    // alphabetical or insertion-order from OpenClaw's perspective), so a
    // round-trip changes the array even though the *set* is identical.
    //
    // Concrete failure observed in CI run 25222971253:
    //   existing:  ["pinchy-audit", "pinchy-context", "pinchy-docs", "telegram"]
    //   produced:  ["telegram", "pinchy-audit", "pinchy-context", "pinchy-docs"]
    //   -> OpenClaw: "[reload] config change requires gateway restart (plugins.allow)"
    //
    // Fix: walk existingAllow in order, keep entries that still apply,
    // append only genuinely new pinchy plugins at the end.
    //
    // No-client mode: regenerate must produce stable order via the
    // file-write path alone. Avoiding config.apply here also stops async
    // RPC promises from leaking into the next test (mocks are cleared but
    // implementations persist across tests in this describe block).
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });

    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "secret" } },
      plugins: {
        allow: ["pinchy-audit", "telegram"],
        entries: {
          telegram: { enabled: true },
          "pinchy-audit": { enabled: true, config: {} },
        },
      },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          enabled: true,
          accounts: { "agent-1": { botToken: "123456:ABC-token" } },
        },
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-token";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);

    // Order must match the existing file exactly. Anything else - even with
    // identical contents - triggers a full gateway restart.
    expect(config.plugins.allow).toEqual(["pinchy-audit", "telegram"]);
  });

  it("appends new pinchy plugins at the end of plugins.allow (#193 follow-up)", async () => {
    // Order-preservation must not break the "newly-needed plugin gets
    // enabled" path. New pinchy plugins (i.e. ones with entries that the
    // existing config didn't list) should still end up in allow, just at
    // the tail - so the existing prefix stays byte-identical and only the
    // new entry shows up as a diff.
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });

    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "secret" } },
      plugins: {
        allow: ["telegram"],
        entries: { telegram: { enabled: true } },
      },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          enabled: true,
          accounts: { "agent-1": { botToken: "123456:ABC-token" } },
        },
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-token";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);

    // Existing entry stays first; the newly-needed pinchy-audit lands at the
    // end, not interleaved.
    expect(config.plugins.allow[0]).toBe("telegram");
    expect(config.plugins.allow).toContain("pinchy-audit");
  });

  it("plugins.allow is byte-stable across an OpenClaw mid-flight reorder (#193 follow-up)", async () => {
    // The production cascade isn't just "Pinchy round-trips its own
    // output" - it's "Pinchy writes, OpenClaw boots and rewrites with a
    // different order on auto-enable, Pinchy regenerates against the
    // rewritten file." Order-preservation must survive that handoff:
    // whatever OpenClaw wrote becomes the new baseline, and the next
    // Pinchy regenerate must NOT churn it back.
    //
    // Without this property, the cascade is: Pinchy write A -> OpenClaw
    // rewrites as B -> Pinchy regenerate produces A -> diff -> restart
    // -> OpenClaw rewrites as B -> ... ad infinitum.
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });

    // Step 1: Pinchy's first generate (cold start, no existing file).
    // Use a personal agent with context tools so the cold-start config
    // emits 3+ plugins (pinchy-audit + pinchy-docs + pinchy-context),
    // making the order-reversal in step 2 actually meaningful.
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          isPersonal: true,
          ownerId: "user-1",
          allowedTools: ["pinchy_save_user_context"],
          createdAt: new Date(),
        },
      ]),
    } as never);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-token";
      return null;
    });

    await regenerateOpenClawConfig();
    const firstWrite = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(firstWrite).toBeDefined();
    const firstContent = firstWrite![1] as string;
    const firstConfig = JSON.parse(firstContent);

    // Step 2: simulate OpenClaw boot rewriting plugins.allow with a
    // different (but set-equivalent) order. This is the canonical bug
    // trigger - OpenClaw's auto-enable doesn't preserve Pinchy's order.
    const reorderedAllow = [...firstConfig.plugins.allow].reverse();
    expect(reorderedAllow).not.toEqual(firstConfig.plugins.allow);

    const openClawRewritten = {
      ...firstConfig,
      plugins: {
        ...firstConfig.plugins,
        allow: reorderedAllow,
      },
    };

    // Step 3: Pinchy regenerates against OpenClaw's reordered file.
    mockedWriteFileSync.mockClear();
    mockedReadFileSync.mockReturnValue(JSON.stringify(openClawRewritten, null, 2));

    await regenerateOpenClawConfig();
    const secondWrite = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );

    // Two acceptable outcomes: (a) early-return because content is byte-
    // identical (best case, no restart trigger at all), or (b) a write
    // whose plugins.allow matches OpenClaw's reordered version exactly.
    // The bad outcome - which my fix prevents - would be a write that
    // restored Pinchy's original order, restarting the cascade.
    if (secondWrite) {
      const secondConfig = JSON.parse(secondWrite[1] as string);
      expect(secondConfig.plugins.allow).toEqual(reorderedAllow);
    }
    // If no second write, the early-return path has already proven byte
    // stability - no further assertion needed.
  });

  it("skips file write and config.apply RPC when only meta.lastTouchedAt differs (#193, openclaw#75534)", async () => {
    // OpenClaw stamps `meta.lastTouchedAt = now()` on every write it
    // performs (config.apply RPC, internal restart-bookkeeping). Pinchy
    // preserves `meta` from the existing config when regenerating, so
    // back-to-back regenerates with no DB changes produce content that
    // differs ONLY in that field. A byte-equal early return doesn't catch
    // this, so without normalize-compare Pinchy would still send a
    // config.apply RPC, OpenClaw's diff would (spuriously, see
    // openclaw#75534) flag env.* paths as changed against its
    // runtime-resolved snapshot, and trigger a full gateway restart.
    //
    // Asserts: when only meta.lastTouchedAt differs, regenerateOpenClawConfig
    // makes NO write to the openclaw.json path AND NO config.apply RPC call.
    mockGetClient.mockReturnValue({
      config: {
        get: mockConfigGet,
        apply: mockConfigApply,
      },
    });
    mockConfigGet.mockResolvedValue({ hash: "h1" });
    mockConfigApply.mockResolvedValue(undefined);

    const baseConfig = {
      meta: { lastTouchedAt: "2026-05-01T10:00:00.000Z" },
      gateway: { mode: "local", bind: "lan", auth: { token: "t" } },
      env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" },
      agents: { list: [] },
      plugins: {
        allow: ["pinchy-audit"],
        entries: { "pinchy-audit": { enabled: true, config: {} } },
      },
    };

    mockedDb.select.mockReturnValue({
      from: mockFrom([]),
    } as never);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-fake";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    // First generate with no existing file — Pinchy writes the initial config
    // and kicks off a background config.apply.
    await regenerateOpenClawConfig();
    const firstWrite = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(firstWrite).toBeDefined();
    const firstContent = firstWrite![1] as string;

    // Drain the first generate's background coroutine. Without this, its
    // delayed config.apply call would race with the post-test assertion.
    await drainBackgroundCoroutine();
    const applyCallsBeforeSecondGenerate = mockConfigApply.mock.calls.length;

    // Now simulate OpenClaw having stamped a NEW lastTouchedAt onto the file
    // (the only difference; everything else byte-identical).
    const stampedExisting = JSON.parse(firstContent);
    if (!stampedExisting.meta) stampedExisting.meta = {};
    stampedExisting.meta.lastTouchedAt = "2026-05-01T10:05:00.000Z";
    const stampedExistingStr = JSON.stringify(stampedExisting, null, 2);

    mockedWriteFileSync.mockClear();
    mockedReadFileSync.mockReturnValue(stampedExistingStr);

    await regenerateOpenClawConfig();
    // Drain any background work the second generate might have scheduled.
    await drainBackgroundCoroutine();

    // No openclaw.json write (the only diff was OpenClaw-managed metadata).
    const secondConfigWrite = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(secondConfigWrite).toBeUndefined();

    // No NEW config.apply RPC. Without the workaround, sending the RPC would
    // trigger OpenClaw's snapshot-vs-parsed env-resolution diff and a full
    // restart. Compare against the count after the first generate, not zero,
    // because the first generate legitimately pushes once.
    expect(mockConfigApply.mock.calls.length).toBe(applyCallsBeforeSecondGenerate);
  });

  it("config.apply payload has no env block after SecretRef migration (env-templates gone)", async () => {
    // After Phase 2, provider API keys use SecretRef in models.providers.* — no
    // env-templates in openclaw.json.
    mockGetClient.mockReturnValue({
      config: { get: mockConfigGet, apply: mockConfigApply },
    });
    mockConfigGet.mockResolvedValue({ hash: "h-existing" });
    mockConfigApply.mockResolvedValue(undefined);

    // Existing on disk may have an env block from before the migration.
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "t" } },
      env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" },
      agents: {
        list: [{ id: "a1", name: "Smithers", model: "anthropic/claude-haiku-4-5-20251001" }],
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig, null, 2));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "a1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
        {
          id: "a2",
          name: "NewAgent",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-fake";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();
    await drainBackgroundCoroutine();

    expect(mockConfigApply).toHaveBeenCalledTimes(1);
    const [payload] = mockConfigApply.mock.calls[0];
    const sent = JSON.parse(payload as string) as Record<string, unknown>;

    // No env block — provider API keys are in models.providers.* now.
    expect(sent.env).toBeUndefined();
    // API key is a SecretRef in models.providers.anthropic
    expect((sent as Record<string, unknown>)?.models).toBeDefined();
  });

  it("new provider config sends SecretRef (not env-template) in config.apply payload", async () => {
    // After Phase 2, adding a new provider (e.g. user adds OpenAI key for the
    // first time) emits a SecretRef in models.providers.openai — no env-template.
    // No env diff → no spurious restart for env.* paths.
    mockGetClient.mockReturnValue({
      config: { get: mockConfigGet, apply: mockConfigApply },
    });
    mockConfigGet.mockResolvedValue({ hash: "h-existing" });
    mockConfigApply.mockResolvedValue(undefined);

    // Existing has only Anthropic (from before the migration).
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "t" } },
      env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" },
      agents: { list: [] },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig, null, 2));

    mockedDb.select.mockReturnValue({ from: mockFrom([]) } as never);
    // Pinchy now has BOTH anthropic and openai configured.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-fake";
      if (key === "openai_api_key") return "sk-openai-fake";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();
    await drainBackgroundCoroutine();

    expect(mockConfigApply).toHaveBeenCalledTimes(1);
    const [payload] = mockConfigApply.mock.calls[0];
    const sent = JSON.parse(payload as string) as Record<string, unknown>;

    // No env block — both providers use SecretRef in models.providers.*
    expect(sent.env).toBeUndefined();
    const models = sent.models as Record<string, unknown> | undefined;
    const providers = (models?.providers as Record<string, unknown>) ?? {};
    expect(providers.anthropic).toBeDefined();
    expect(providers.openai).toBeDefined();
  });

  it("regenerateOpenClawConfig is byte-idempotent against its own previous output (#193)", async () => {
    // Hardest assertion: two consecutive generates with identical DB state
    // must produce identical openclaw.json content. If they don't, OpenClaw
    // sees a config diff on every settings save and may restart the gateway
    // depending on which paths differ. This test specifically catches the
    // class of bug where Pinchy's regenerate strips fields it doesn't know
    // about that OpenClaw legitimately wrote back.
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-token";
      return null;
    });

    // First generate: no existing file (cold start).
    await regenerateOpenClawConfig();
    const firstWrite = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(firstWrite).toBeDefined();
    const firstContent = firstWrite![1] as string;

    // Reset call log; seed the existing-file read with what we just wrote.
    mockedWriteFileSync.mockClear();
    mockedReadFileSync.mockReturnValue(firstContent);

    // Second generate against the file Pinchy itself just wrote.
    await regenerateOpenClawConfig();

    // Two outcomes are acceptable: (a) early-return because content is
    // identical (no second write at all — best case), or (b) a write whose
    // content equals the first. Either proves idempotency.
    const secondWrite = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    if (secondWrite) {
      expect(secondWrite[1]).toBe(firstContent);
    }
  });

  it("preserves plugins.allow order when an OpenClaw-managed plugin (telegram) is appended after Pinchy's pinchy-* plugins (#237 cascade)", async () => {
    // Real-world failure mode driving the agent-create-no-restart flake:
    //   1. Pinchy first-write: allow = ["pinchy-audit", "pinchy-context", "pinchy-docs"]
    //   2. connectBot → OpenClaw auto-enables telegram and APPENDS it to the
    //      list, producing allow = ["pinchy-audit", "pinchy-context",
    //      "pinchy-docs", "telegram"] on disk after restart.
    //   3. Next regenerate (POST /api/agents) reads that file, then rebuilds
    //      allow as `[...openClawPlugins, ...ourPlugins-in-insertion-order]`,
    //      producing ["telegram", "pinchy-docs", "pinchy-context", "pinchy-audit"].
    //   4. OpenClaw's file-watcher diffs the new file against its in-memory
    //      currentCompareConfig, sees `plugins.allow` reordered, and triggers
    //      a full gateway restart (plugins.allow is restart-required).
    //
    // The fix is to preserve the existing order: keep wanted entries at their
    // original positions, append truly new plugins at the end. With no
    // additions/removals, the array must be byte-identical to existing.
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: ["pinchy_save_user_context"],
          isPersonal: true,
          ownerId: "user-1",
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-token";
      if (key === "default_provider") return "anthropic";
      if (key === "anthropic_api_key") return "sk-ant-fake";
      return null;
    });

    // Existing config models the post-connectBot, post-restart state.
    // OpenClaw appended `telegram` AFTER Pinchy's pinchy-* plugins.
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "t" } },
      env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" },
      agents: {
        defaults: { model: { primary: "anthropic/claude-haiku-4-5-20251001" } },
        list: [
          {
            id: "agent-1",
            name: "Smithers",
            model: "anthropic/claude-haiku-4-5-20251001",
            workspace: "/agents/agent-1",
            heartbeat: { every: "0m" },
          },
        ],
      },
      plugins: {
        allow: ["pinchy-audit", "pinchy-context", "pinchy-docs", "telegram"],
        entries: {
          "pinchy-audit": { enabled: true, config: {} },
          "pinchy-context": { enabled: true, config: {} },
          "pinchy-docs": { enabled: true, config: {} },
          telegram: { enabled: true },
        },
      },
      channels: { telegram: { enabled: true } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig, null, 2).trimEnd() + "\n");

    await regenerateOpenClawConfig();

    const write = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    if (write) {
      const written = JSON.parse(write[1] as string);
      // Same set, same order. Without the fix, telegram migrates to position 0
      // and the pinchy-* entries get re-shuffled by entries-insertion order.
      expect(written.plugins.allow).toEqual([
        "pinchy-audit",
        "pinchy-context",
        "pinchy-docs",
        "telegram",
      ]);
    }
    // Acceptable alternative: byte-equal early return (no write).
    // Either proves the regenerate did not reorder allow.
  });
});

describe("writeConfigAtomic plaintext secret guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedDb.select.mockReturnValue({
      from: mockFrom(),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
  });

  it("does NOT throw when provider keys are configured — written as SecretRef, never plaintext", async () => {
    // Provider API keys use SecretRef in models.providers.* — no plaintext in openclaw.json.
    // OpenClaw resolves the SecretRef from secrets.json at runtime.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-leaked-plaintext-key-abc123";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await expect(regenerateOpenClawConfig()).resolves.toBeUndefined();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);
    // SecretRef (not plaintext, not env-template) written to openclaw.json
    expect(config?.models?.providers?.anthropic?.apiKey).toMatchObject({
      source: "file",
      provider: "pinchy",
      id: "/providers/anthropic/apiKey",
    });
    // Actual key is in secrets.json via writeSecretsFile, never in openclaw.json
    expect(mockWriteSecretsFile).toHaveBeenCalled();
    expect(mockWriteSecretsFile.mock.calls[0][0].providers?.anthropic?.apiKey).toBe(
      "sk-ant-leaked-plaintext-key-abc123"
    );
  });
});

describe("regenerateOpenClawConfig — env secrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedDb.select.mockReturnValue({
      from: mockFrom(),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
    process.env.OPENCLAW_SECRETS_PATH = "/tmp/test-secrets.json";
  });

  afterEach(() => {
    delete process.env.OPENCLAW_SECRETS_PATH;
  });

  it("writes anthropic apiKey as SecretRef in models.providers.anthropic, not as env-template", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-the-real-key";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);

    // Provider API keys use SecretRef — OpenClaw resolves from secrets.json live.
    expect(config?.models?.providers?.anthropic?.apiKey).toMatchObject({
      source: "file",
      provider: "pinchy",
      id: "/providers/anthropic/apiKey",
    });
    expect(config?.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("writes the actual plaintext key to secrets.json under /providers/anthropic/apiKey", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-the-real-key";
      return null;
    });

    await regenerateOpenClawConfig();

    expect(mockWriteSecretsFile).toHaveBeenCalled();
    const secretsArg = mockWriteSecretsFile.mock.calls[0][0];
    expect(secretsArg.providers?.anthropic?.apiKey).toBe("sk-ant-the-real-key");
  });

  it("does NOT write secrets.env (env-export bash loop removed in Phase 2.4)", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-the-real-key";
      if (key === "openai_api_key") return "sk-openai-real-key";
      return null;
    });

    await regenerateOpenClawConfig();

    const secretsArg = mockWriteSecretsFile.mock.calls[0][0];
    // Provider keys are now resolved live from secrets.providers.* via SecretRef.
    // start-openclaw.sh no longer exports process env vars — secrets.env is gone.
    expect(secretsArg.env).toBeUndefined();
  });

  it("writes secrets.json BEFORE openclaw.json", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-the-real-key";
      return null;
    });

    const order: string[] = [];
    mockWriteSecretsFile.mockImplementation(() => {
      order.push("secrets.json");
    });
    mockedWriteFileSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.includes("openclaw.json")) {
        order.push("openclaw.json");
      }
    });

    await regenerateOpenClawConfig();

    const secretsIdx = order.indexOf("secrets.json");
    const configIdx = order.indexOf("openclaw.json");
    expect(secretsIdx).toBeGreaterThanOrEqual(0);
    expect(configIdx).toBeGreaterThanOrEqual(0);
    expect(secretsIdx).toBeLessThan(configIdx);
  });

  it("writes secrets.json even when openclaw.json content is unchanged (early-return path)", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-the-real-key";
      return null;
    });

    // First call writes the config — capture what was written
    await regenerateOpenClawConfig();
    const firstWrite = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    )![1] as string;

    vi.clearAllMocks();
    // Simulate openclaw.json already containing the same content — triggers early return
    mockedReadFileSync.mockReturnValue(firstWrite);
    mockedExistsSync.mockReturnValue(true);
    mockedDb.select.mockReturnValue({
      from: mockFrom(),
    } as never);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-the-real-key";
      return null;
    });

    // Act: second call with same settings → early return fires
    await regenerateOpenClawConfig();

    // secrets.json MUST still be written (tmpfs is wiped on container restart)
    expect(mockWriteSecretsFile).toHaveBeenCalledOnce();

    // openclaw.json must NOT be written (early return)
    const configWrite = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(configWrite).toBeUndefined();
  });

  it("writes models.providers.ollama-cloud.apiKey as SecretRef and stores value in secrets.json", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-cloud-secret";
      return null;
    });

    await regenerateOpenClawConfig();

    // openclaw.json must contain a SecretRef, not the plaintext key
    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);
    expect(config.models.providers["ollama-cloud"].apiKey).toEqual({
      source: "file",
      provider: "pinchy",
      id: "/providers/ollama-cloud/apiKey",
    });

    // secrets.json must contain the actual key
    expect(mockWriteSecretsFile).toHaveBeenCalled();
    const secretsArg = mockWriteSecretsFile.mock.calls[0][0];
    expect(secretsArg.providers?.["ollama-cloud"]?.apiKey).toBe("sk-ollama-cloud-secret");
  });
});

describe("pinchy-* plugin gatewayToken as SecretRef", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetOrCreateGatewayToken.mockResolvedValue("gw-secret-token");
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockReadSecretsFile.mockReturnValue({});
    mockedDb.select.mockReturnValue({
      from: mockFrom(),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
  });

  const GW_TOKEN_REF = { source: "file", provider: "pinchy", id: "/gateway/token" };

  it("preserves gateway.auth.token as plain string, keeps mode and bind", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-secret-token" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    const config = JSON.parse(written![1] as string);

    // gateway.auth.token comes from getOrCreateGatewayToken() (DB) as a plain string
    // — OpenClaw requires a literal string, not a SecretRef object
    expect(config.gateway.auth).toEqual({ mode: "token", token: "gw-secret-token" });
    // mode and bind are always set
    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
  });

  it("reads gateway token from secrets.json when DB is unavailable (fallback path)", async () => {
    // Fallback scenario: DB throws (pre-setup) and secrets.json has the token
    mockedGetOrCreateGatewayToken.mockRejectedValue(new Error("DB unavailable"));
    mockReadSecretsFile.mockReturnValue({ gateway: { token: "gw-token-from-secrets" } });

    await regenerateOpenClawConfig();

    expect(mockWriteSecretsFile).toHaveBeenCalled();
    const secretsArg = mockWriteSecretsFile.mock.calls[0][0];
    expect(secretsArg.gateway?.token).toBe("gw-token-from-secrets");
  });

  it("writes pinchy-files.config.gatewayToken as plain string (OpenClaw 2026.4.26 plugin config)", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-secret-token" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "kb-agent-id",
          name: "HR KB",
          model: "anthropic/claude-haiku-4-5-20251001",
          pluginConfig: { "pinchy-files": { allowed_paths: ["/data/"] } },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    const config = JSON.parse(written![1] as string);
    expect(config.plugins.entries["pinchy-files"].config.gatewayToken).toBe("gw-secret-token");
  });

  it("writes pinchy-context.config.gatewayToken as plain string (OpenClaw 2026.4.26 plugin config)", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-secret-token" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-6",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context"],
          ownerId: "user-1",
          isPersonal: true,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    const config = JSON.parse(written![1] as string);
    expect(config.plugins.entries["pinchy-context"].config.gatewayToken).toBe("gw-secret-token");
  });

  it("writes pinchy-audit.config.gatewayToken as plain string (OpenClaw 2026.4.26 plugin config)", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-secret-token" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    const config = JSON.parse(written![1] as string);
    expect(config.plugins.entries["pinchy-audit"].config.gatewayToken).toBe("gw-secret-token");
  });

  it("writes pinchy-email.config.gatewayToken as plain string (OpenClaw 2026.4.26 plugin config)", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-secret-token" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    const emailPermissionsData = [
      {
        agent_connection_permissions: {
          agentId: "email-agent",
          connectionId: "email-conn-1",
          model: "email",
          operation: "read",
        },
        integration_connections: {
          id: "email-conn-1",
          type: "google",
          name: "Gmail",
          description: "",
          credentials: "{}",
          data: null,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(
          Promise.resolve([
            {
              id: "email-agent",
              name: "Email Agent",
              model: "anthropic/claude-haiku-4-5-20251001",
              allowedTools: ["pinchy_email_read"],
              createdAt: new Date(),
            },
          ]),
          {
            innerJoin: mockInnerJoin(emailPermissionsData),
            where: vi.fn().mockResolvedValue([]),
          }
        )
      ),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    const config = JSON.parse(written![1] as string);
    expect(config.plugins.entries["pinchy-email"].config.gatewayToken).toBe("gw-secret-token");
  });

  it("stores gateway token under secrets.gateway.token", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-secret-token" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    await regenerateOpenClawConfig();

    expect(mockWriteSecretsFile).toHaveBeenCalled();
    const secretsArg = mockWriteSecretsFile.mock.calls[0][0];
    expect(secretsArg.gateway?.token).toBe("gw-secret-token");
  });

  it("does not include gateway in secrets when DB is unavailable and no fallback token exists", async () => {
    // DB throws and no secrets.json fallback → no token anywhere → gateway absent from secrets
    mockedGetOrCreateGatewayToken.mockRejectedValue(new Error("DB unavailable"));
    // mockReadSecretsFile already returns {} from beforeEach

    await regenerateOpenClawConfig();

    expect(mockWriteSecretsFile).toHaveBeenCalled();
    const secretsArg = mockWriteSecretsFile.mock.calls[0][0];
    expect(secretsArg.gateway).toBeUndefined();
  });
});

describe("secrets provider config block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedDb.select.mockReturnValue({
      from: mockFrom(),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
  });

  it("writes secrets.providers.pinchy pointing at /openclaw-secrets/secrets.json", async () => {
    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);

    expect(config.secrets.providers.pinchy).toEqual({
      source: "file",
      path: "/openclaw-secrets/secrets.json",
      mode: "json",
    });
  });
});

describe("updateIdentityLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("should only update session.identityLinks without touching other fields", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "secret" } },
      env: { ANTHROPIC_API_KEY: "sk-ant-key" },
      agents: {
        defaults: { model: { primary: "anthropic/claude" }, heartbeat: { intervalMs: 1800000 } },
        list: [{ id: "agent-1", name: "Smithers" }],
      },
      channels: { telegram: { enabled: true, botToken: "123:abc", dmPolicy: "pairing" } },
      plugins: { allow: ["telegram", "pinchy-audit"], entries: {} },
      meta: { version: "1.0" },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    const { updateIdentityLinks } = await import("@/lib/openclaw-config");
    await updateIdentityLinks({ "user-1": ["telegram:8754697762"] });

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);

    // identityLinks updated
    expect(written.session.identityLinks).toEqual({ "user-1": ["telegram:8754697762"] });

    // Everything else preserved exactly
    expect(written.agents.defaults.heartbeat).toEqual({ intervalMs: 1800000 });
    expect(written.agents.defaults.model).toEqual({ primary: "anthropic/claude" });
    expect(written.agents.list).toEqual([{ id: "agent-1", name: "Smithers" }]);
    expect(written.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(written.plugins.allow).toEqual(["telegram", "pinchy-audit"]);
    expect(written.meta.version).toBe("1.0");
    expect(written.channels.telegram.botToken).toBe("123:abc");
  });

  it("should remove identityLinks when called with empty object", async () => {
    const existingConfig = {
      gateway: { mode: "local" },
      session: { dmScope: "per-peer", identityLinks: { "user-1": ["telegram:123"] } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    const { updateIdentityLinks } = await import("@/lib/openclaw-config");
    await updateIdentityLinks({});

    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written.session.identityLinks).toEqual({});
    expect(written.session.dmScope).toBe("per-peer");
    expect(written.gateway.mode).toBe("local");
  });

  it("should skip write when identityLinks unchanged", async () => {
    const existingConfig = {
      gateway: { mode: "local" },
      session: { identityLinks: { "user-1": ["telegram:123"] } },
    };
    // readFileSync is called twice: once by readExistingConfig, once by the skip-if-unchanged check.
    // Both must return the same content that would be produced by JSON.stringify(updated, null, 2)
    // followed by trimEnd() + "\n" — see openclaw-config.ts for the format-match rationale.
    const serialized = JSON.stringify(existingConfig, null, 2).trimEnd() + "\n";
    mockedReadFileSync.mockReturnValue(serialized);

    const { updateIdentityLinks } = await import("@/lib/openclaw-config");
    updateIdentityLinks({ "user-1": ["telegram:123"] });

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("regression: throws if existing config has no gateway.mode (avoids clobber from EACCES)", async () => {
    // This reproduces the production-image telegram-e2e cascade: while
    // OpenClaw is mid-SIGUSR1-restart, openclaw.json is briefly root:0600.
    // readExistingConfig hits EACCES, returns {} after retries. Without
    // the safety check below, updateIdentityLinks would write a config
    // with ONLY a session block — no gateway, no agents, nothing — and
    // OpenClaw's next start refuses with "missing gateway.mode" then
    // crash-loops.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as Error & { code: string };
      err.code = "EACCES";
      throw err;
    });

    const { updateIdentityLinks } = await import("@/lib/openclaw-config");

    // Throwing (rather than silently returning) lets the API route surface
    // the failure as a 5xx so the user can retry, instead of dropping the
    // identity-link update on the floor.
    expect(() => updateIdentityLinks({ "user-1": ["telegram:123"] })).toThrow(/gateway\.mode/);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("telegram botToken plain string (OpenClaw 2026.4.26 does not support SecretRef in channel configs)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedDb.select.mockReturnValue({
      from: mockFrom(),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
  });

  it("writes telegram botToken as plain string in openclaw.json", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-42",
          name: "Bot Agent",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          isPersonal: false,
          ownerId: null,
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-42") return "bot-secret-token";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(written![1] as string);

    expect(config.channels.telegram.accounts["agent-42"].botToken).toBe("bot-secret-token");
  });

  it("updateTelegramChannelConfig writes botToken as plain string", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan" },
      })
    );

    updateTelegramChannelConfig("agent-99", { botToken: "tg-secret-token" }, null);

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.channels.telegram.accounts["agent-99"].botToken).toBe("tg-secret-token");
  });
});
