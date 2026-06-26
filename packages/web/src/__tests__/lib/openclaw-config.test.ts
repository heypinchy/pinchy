import { describe, it, expect, vi, beforeEach } from "vitest";
import { isOpenClawLocalBaseUrl } from "@/lib/openclaw-local-url";

vi.mock("@/lib/model-vision", () => ({
  isModelVisionCapable: vi.fn((modelId: string) => {
    const provider = modelId.split("/")[0];
    return ["anthropic", "google", "openai", "ollama-cloud"].includes(provider);
  }),
  setOllamaLocalVisionModels: vi.fn().mockResolvedValue(undefined),
}));

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
  setSetting: vi.fn().mockResolvedValue(undefined),
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

const { mockValidateBuiltConfig } = vi.hoisted(() => ({
  mockValidateBuiltConfig: vi.fn().mockReturnValue({ ok: true }),
}));

vi.mock("@/lib/openclaw-config/validate-built-config", () => ({
  validateBuiltConfig: mockValidateBuiltConfig,
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
  // Default "live" catalog: all three ollama-cloud image-preference models are
  // present. Individual tests override this to simulate an upstream retirement
  // (a model dropping out of /v1/models).
  const fetchProviderModels = vi.fn(async () => [
    {
      id: "ollama-cloud",
      name: "Ollama Cloud",
      models: [
        { id: "ollama-cloud/gemini-3-flash-preview", name: "gemini-3-flash-preview" },
        { id: "ollama-cloud/minimax-m3", name: "minimax-m3" },
        { id: "ollama-cloud/gemma4:31b", name: "gemma4:31b" },
      ],
    },
  ]);
  return {
    getDefaultModel: vi.fn(async (provider: string) => defaults[provider] ?? ""),
    fetchProviderModels,
    fetchOllamaLocalModelsFromUrl: vi.fn().mockResolvedValue([]),
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
  sanitizeOpenClawConfig,
  seedRestartClassOverridesIfMissing,
  seedGatewayTokenIfMissing,
  updateTelegramChannelConfig,
  DEFAULT_DOCS_PUBLIC_BASE_URL,
  DOCS_PUBLIC_BASE_URL_SETTING_KEY,
} from "@/lib/openclaw-config";
import { pushConfigInBackground, _resetPushGeneration } from "@/lib/openclaw-config/write";
import { getPendingConfigPushCount, _resetConfigPushState } from "@/lib/openclaw-config/push-state";
import { db } from "@/db";
import { getSetting } from "@/lib/settings";
import { fetchOllamaLocalModelsFromUrl, fetchProviderModels } from "@/lib/provider-models";

const mockedFetchProviderModels = vi.mocked(fetchProviderModels);
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

// Top-level guard: vi.clearAllMocks() in each describe's beforeEach clears
// call history but NOT mock implementations. A test that calls
// mockGetClient.mockReturnValue({...}) to simulate a connected client would
// pollute subsequent sibling describe blocks. This runs before every
// describe-level beforeEach, resetting to "no WS client" as the baseline.
beforeEach(() => {
  mockGetClient.mockImplementation(() => {
    throw new Error("OpenClaw client not initialized");
  });
});

// Drift guard: re-export the shared `isOpenClawLocalBaseUrl` (see
// @/lib/openclaw-local-url) under the local name used by the assertions in
// this file. The shared module is a 1:1 port of OpenClaw's `isLocalBaseUrl`
// predicate and now also backs save-time rejection in `validateProviderUrl`
// (#296), so this file no longer ships a private duplicate.
const mirrorOpenClawIsLocalBaseUrl = isOpenClawLocalBaseUrl;

/**
 * Load OpenClaw's REAL pre-compaction memory-flush plan resolver from the
 * installed `openclaw` package. We feed Pinchy's emitted config to OpenClaw's
 * own gate logic instead of re-asserting our field name in isolation: if a
 * future OpenClaw bump renames or moves the disable flag, this resolver stops
 * honoring our config and the contract test goes red — a behavior guard that
 * survives key renames (see test_real_dependency_not_mock memory).
 *
 * The flush plan resolver is registered by the memory-core plugin via
 * `registerMemoryCapability({ flushPlanResolver })`. We invoke the plugin's
 * `register()` with a capturing stub to extract it. The deep dist path is
 * intentional: if OpenClaw restructures it, the import throws loudly, which is
 * the signal to re-verify the contract against the new version.
 */
async function loadOpenClawFlushResolver(): Promise<(params: { cfg: unknown }) => unknown | null> {
  const { createRequire } = await import("module");
  const { pathToFileURL } = await import("url");
  const pathMod = await import("path");
  const require = createRequire(import.meta.url);
  // `openclaw`'s exports map blocks `./package.json`, so resolve the main entry
  // (`.` → dist/index.js) and walk to the sibling extensions dir.
  const distIndex = require.resolve("openclaw");
  const memCorePath = pathMod.join(pathMod.dirname(distIndex), "extensions/memory-core/index.js");
  const mod = await import(pathToFileURL(memCorePath).href);
  const plugin = mod.default;

  let captured: { flushPlanResolver?: (params: { cfg: unknown }) => unknown } | undefined;
  const noop = () => undefined;
  const capturingApi = new Proxy(
    {
      registerMemoryCapability: (cap: typeof captured) => {
        captured = cap;
      },
      logger: { warn: noop, info: noop, debug: noop, error: noop },
    } as Record<string, unknown>,
    { get: (target, prop) => (prop in target ? target[prop as string] : noop) }
  );
  plugin.register(capturingApi);

  const resolver = captured?.flushPlanResolver;
  if (typeof resolver !== "function") {
    throw new Error(
      "OpenClaw memory-core no longer exposes a flushPlanResolver — re-verify the memory-flush disable contract against the installed openclaw version."
    );
  }
  return resolver;
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
    delete process.env.PINCHY_E2E_OLLAMA_LOCAL_API_KEY;
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

  it("should write config with shared-volume file permissions (Pinchy + OpenClaw both r/w)", async () => {
    // Mode 0o666 (was 0o644 until May 2026): both Pinchy (uid 999) and
    // OpenClaw (root) need to read AND write openclaw.json on the shared
    // /openclaw-config volume. With 0o644, every Pinchy write set the file
    // back to mode 644, then OpenClaw's next internal SIGUSR1 restart wrote
    // it as root:0600, then start-openclaw.sh's chmod-loop ran 0o666 →
    // 200 ms race window where Pinchy could read 600 in the Docker smoke
    // test's `Verify OpenClaw config writable by Pinchy` check. Writing
    // 0o666 directly closes Pinchy's contribution to that race. (OpenClaw's
    // 600 writes still need the chmod-loop, which now ticks at 50 ms.)
    await regenerateOpenClawConfig();

    expect(mockedWriteFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      encoding: "utf-8",
      mode: 0o666,
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

  it("emits gateway.controlUi.allowedOrigins so OpenClaw's in-memory seed never diffs", async () => {
    // OpenClaw 2026.2.26+ seeds gateway.controlUi.allowedOrigins in memory for a
    // bind:"lan" gateway but never writes it to openclaw.json. If Pinchy's
    // regenerate omits it, OC's reload diff sees gateway.controlUi.allowedOrigins
    // removed → restart-class change → SIGUSR1 cascade that delays agents.list
    // hot-reload (the setup-wizard "unknown agent id" / #193 flake on 2026.5.28).
    // Pinchy must always emit the same origins OC seeds.
    mockedReadFileSync.mockReturnValue("" as unknown as Buffer); // cold start: no existing config
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();
    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written) as {
      gateway?: { controlUi?: { enabled?: boolean; allowedOrigins?: string[] } };
    };
    expect(config.gateway?.controlUi?.enabled).toBe(false);
    expect(config.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
  });

  it("preserves an existing controlUi.allowedOrigins value emitted by OpenClaw", async () => {
    // If OpenClaw enriched controlUi.allowedOrigins with a different value (e.g.
    // a prior config.apply persisted it), Pinchy must round-trip that exact
    // value rather than clobber it with the default — otherwise the round-trip
    // itself becomes the restart-class diff.
    const ocEnriched = JSON.stringify({
      gateway: {
        mode: "local",
        bind: "lan",
        controlUi: { enabled: false, allowedOrigins: ["http://oc-enriched.example:18789"] },
      },
    });
    mockedReadFileSync.mockReturnValue(ocEnriched as unknown as Buffer);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();
    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written) as {
      gateway?: { controlUi?: { allowedOrigins?: string[] } };
    };
    expect(config.gateway?.controlUi?.allowedOrigins).toEqual(["http://oc-enriched.example:18789"]);
  });

  it("disables OpenClaw's default daily session reset so chat history persists across days", async () => {
    // OpenClaw's default session reset (`session.reset.mode: "daily"`,
    // `atHour: 4` — confirmed in openclaw@2026.5.7
    // dist/reset-L5yC6_6J.js: `const DEFAULT_RESET_MODE = "daily"`) rotates
    // the `sessionId` for each session key at 4:00 AM local gateway time.
    // The old transcript JSONL stays on disk but the live session pointer
    // moves to a fresh empty transcript, so Pinchy's UI — which loads
    // history for the deterministic `agent:<agentId>:direct:<userId>` key
    // via `client-router.ts:computeSessionKey` — appears to "lose" every
    // user's conversation every morning. The first user to notice was the
    // one whose cron job fired into the post-reset session, surfacing the
    // empty new transcript with the cron message as the only content.
    //
    // Pinchy is an enterprise chat platform: users expect continuous chat
    // history. Setting `mode: "idle"` with `idleMinutes: 525600` (1 year)
    // passes OpenClaw's schema validation (`idleMinutes` must be > 0) while
    // being large enough to never trigger in practice. No daily branch fires
    // (mode is not "daily"), and the idle branch only fires after a full year
    // of inactivity. Manual `/new` / `/reset` are still respected when a
    // user explicitly wants a fresh chat — this only disables the silent
    // auto-rotation.
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.session?.reset).toEqual({ mode: "idle", idleMinutes: 525600 });
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

  it("should keep bundled OpenClaw plugins Pinchy never uses out of plugins.allow without touching plugins.entries", async () => {
    // OpenClaw 2026.4.x ships seven plugins enabledByDefault:
    //   acpx, bonjour, browser, device-pair, memory-core, phone-control, talk-voice
    //
    // Pinchy uses none of acpx, bonjour, device-pair, phone-control:
    //   - acpx: Agent Client Protocol bridge for desktop chat clients
    //     (Claude.app, Zed Codex). Pinchy talks to OpenClaw via openclaw-
    //     node over its WebSocket gateway, never via ACP.
    //   - bonjour: mDNS gateway advertiser. Pinchy reaches OpenClaw on the
    //     Docker bridge via OPENCLAW_WS_URL; multicast doesn't route there.
    //     `discovery.mdns.mode=off` already silences the watchdog but
    //     ~1 MB of @homebridge/ciao deps still load and an announcer starts.
    //   - device-pair: QR-code pairing flow. Pinchy auto-approves devices
    //     with the gateway token in start-openclaw.sh.
    //   - phone-control: phone-node high-risk command arming. Pinchy has
    //     no phone integration.
    //
    // browser, memory-core, talk-voice stay enabled: browser is a planned
    // feature (and gated by Pinchy's tool-registry deny-list anyway),
    // memory-core has activation.onStartup=false (zero startup cost),
    // talk-voice is a tiny TTS picker.
    //
    // Disable mechanism: `plugins.allow` is a hard whitelist per the
    // OpenClaw schema — "when set, only listed plugins are eligible to
    // load". Filtering the four IDs out of `allow` blocks them entirely.
    //
    // We deliberately do NOT also stamp `plugins.entries.<id>.enabled =
    // false`. OpenClaw enriches `plugins.entries.*` at runtime (e.g.
    // sibling `hooks` blocks), and overwriting/removing entries surfaces
    // as a `plugins` config-diff classification → full SIGUSR1 gateway
    // restart (caught by agent-create-no-restart.spec.ts:207). Existing
    // entries for disabled plugins are preserved byte-for-byte; the
    // allowlist alone keeps them from loading and leftover entries are
    // inert.
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan", auth: { token: "tok" } },
        plugins: {
          // Simulate OpenClaw having auto-populated allow with all bundled
          // plugins after a previous boot.
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
            // OpenClaw-side enrichment with a sibling field — Pinchy must
            // NOT strip this on regenerate (would trigger the
            // agent-create-no-restart fingerprint).
            acpx: { enabled: true, hooks: { allowPromptInjection: true } },
            bonjour: { enabled: true },
          },
        },
      })
    );

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written) as {
      plugins?: {
        allow?: string[];
        entries?: Record<string, unknown>;
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

    // Existing entries for disabled plugins are preserved byte-for-byte
    // (including OpenClaw's sibling enrichments). Removing them would diff
    // `plugins` and OpenClaw classifies that as restart-required.
    expect(config.plugins?.entries?.acpx).toEqual({
      enabled: true,
      hooks: { allowPromptInjection: true },
    });
    expect(config.plugins?.entries?.bonjour).toEqual({ enabled: true });

    // Insertion order matters too: a future refactor that sorted entries
    // alphabetically (or otherwise reordered them) would still pass the
    // byte-for-byte equality above but would surface as a `plugins` diff
    // at runtime and trigger the SIGUSR1 cascade. Lock the order
    // explicitly: existing non-pinchy keys keep their original positions
    // after the (currently empty) pinchy-* prefix block.
    const entryKeys = Object.keys(config.plugins?.entries ?? {});
    const acpxIdx = entryKeys.indexOf("acpx");
    const bonjourIdx = entryKeys.indexOf("bonjour");
    expect(acpxIdx).toBeGreaterThanOrEqual(0);
    expect(bonjourIdx).toBe(acpxIdx + 1);
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
      tools: {
        deny: ["group:runtime", "group:fs", "group:web", "image_generate"],
        fs: { workspaceOnly: true },
      },
      heartbeat: { every: "0m" },
      // Empty skills allowlist is intentional — see master issue #543.
      // Excludes OC's 58 bundled desktop skills (1password, apple-notes,
      // ...) from agents Pinchy never opted into them on.
      skills: [],
    });
    expect(config.agents.list[1]).toEqual({
      id: "uuid-agent-2",
      name: "Jeeves",
      model: "openai/gpt-5.4",
      workspace: "/root/.openclaw/workspaces/uuid-agent-2",
      tools: {
        deny: ["group:runtime", "group:fs", "group:web", "image_generate"],
        fs: { workspaceOnly: true },
      },
      heartbeat: { every: "0m" },
      skills: [],
    });
  });

  it("excludes soft-deleted (tombstoned) agents from agents.list", async () => {
    const agentsData = [
      {
        id: "live-1",
        name: "Smithers",
        model: "anthropic/claude-opus-4-7",
        createdAt: new Date(),
        deletedAt: null,
      },
      {
        id: "dead-1",
        name: "Ghost",
        model: "openai/gpt-5.4",
        createdAt: new Date(),
        deletedAt: new Date(),
      },
    ];
    mockedDb.select.mockReturnValue({ from: mockFrom(agentsData) } as never);
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    const ids = config.agents.list.map((a: { id: string }) => a.id);
    expect(ids).toContain("live-1");
    // A tombstoned agent must not be a live, addressable agent in the runtime
    // config (it would point at a deleted workspace + keep its tool config).
    expect(ids).not.toContain("dead-1");
  });

  it("includes the OpenClaw bundled `document-extract` extension in plugins.allow so the pdf tool's extraction fallback works", async () => {
    // Simulate existing plugins.allow WITHOUT document-extract
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan", auth: { token: "tok" } },
        plugins: { allow: ["browser", "memory-core"] },
      })
    );
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.plugins.allow).toContain("document-extract");
  });

  it("emits tools.fs = { workspaceOnly: true } for every agent so built-in pdf/image tools cannot escape the workspace", async () => {
    const agentsData = [
      {
        id: "ws-agent-1",
        name: "Smithers",
        model: "anthropic/claude-opus-4-7",
        createdAt: new Date(),
      },
    ];
    mockedDb.select.mockReturnValue({ from: mockFrom(agentsData) } as never);
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    const agentEntry = config.agents.list.find((a: { id: string }) => a.id === "ws-agent-1");
    expect(agentEntry.tools.fs).toEqual({ workspaceOnly: true });
  });

  // Locks the combined chat-attachment security contract (PR #316 review #3):
  //
  //   1. `pdf` and `image` MUST be available to every agent — they're the
  //      built-in tools the upload hint instructs the agent to call. If
  //      either ends up in `tools.deny`, the entire attachment feature
  //      silently breaks: the agent receives a path it cannot read.
  //
  //   2. `image_generate` MUST remain denied. It produces new content
  //      (token cost, output side-effects) and belongs behind explicit
  //      admin opt-in. This is the explicit boundary documented in
  //      tool-registry.ts § STANDALONE_DENY.
  //
  //   3. `tools.fs.workspaceOnly === true` MUST be set. Without it, `pdf`
  //      and `image` have unrestricted host-filesystem access — an agent
  //      could read /etc/passwd via the `pdf` tool.
  //
  // The three together are the guarantee: agents can read user uploads,
  // confined to the workspace, but cannot generate new content without
  // admin permission. Regression in any one of them silently changes the
  // security posture for every Pinchy install.
  it("locks the chat-attachment security contract: pdf/image allowed + workspace-confined + image_generate denied", async () => {
    const agentsData = [
      {
        id: "security-contract-agent",
        name: "Smithers",
        model: "anthropic/claude-opus-4-7",
        createdAt: new Date(),
      },
    ];
    mockedDb.select.mockReturnValue({ from: mockFrom(agentsData) } as never);
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    const agentEntry = config.agents.list.find(
      (a: { id: string }) => a.id === "security-contract-agent"
    );
    const deny = (agentEntry.tools?.deny ?? []) as string[];

    // (1) pdf/image MUST be reachable (NOT in the deny list).
    expect(deny).not.toContain("pdf");
    expect(deny).not.toContain("image");

    // (2) image_generate MUST stay denied (admin-only).
    expect(deny).toContain("image_generate");

    // (3) workspace confinement MUST be active.
    expect(agentEntry.tools.fs).toEqual({ workspaceOnly: true });
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

  it("includes default baseUrl in anthropic provider config when ANTHROPIC_BASE_URL is unset", async () => {
    delete process.env.ANTHROPIC_BASE_URL;
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();
    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config?.models?.providers?.anthropic?.baseUrl).toBe("https://api.anthropic.com");
  });

  it("ANTHROPIC_BASE_URL env-var overrides the default", async () => {
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

  it("should always include baseUrl in anthropic provider config (OC 5.x requires it)", async () => {
    // OC 5.x changed models.providers.* to require baseUrl for all providers.
    // When ANTHROPIC_BASE_URL is not set, Pinchy writes the OC default so
    // health-check gateway restarts don't fail with
    // "anthropic.baseUrl: Invalid input: expected string, received undefined".
    delete process.env.ANTHROPIC_BASE_URL;
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();
    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config?.models?.providers?.anthropic?.baseUrl).toBe("https://api.anthropic.com");
  });

  it("includes default baseUrl in openai provider config when OPENAI_BASE_URL is unset", async () => {
    delete process.env.OPENAI_BASE_URL;
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "openai_api_key") return "sk-openai-key";
      if (key === "default_provider") return "openai";
      return null;
    });

    await regenerateOpenClawConfig();
    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config?.models?.providers?.openai?.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("OPENAI_BASE_URL env-var overrides the default", async () => {
    process.env.OPENAI_BASE_URL = "https://openai-proxy.example.com/v1";
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "openai_api_key") return "sk-openai-key";
      if (key === "default_provider") return "openai";
      return null;
    });

    try {
      await regenerateOpenClawConfig();
      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);
      expect(config?.models?.providers?.openai?.baseUrl).toBe(
        "https://openai-proxy.example.com/v1"
      );
    } finally {
      delete process.env.OPENAI_BASE_URL;
    }
  });

  it("includes default baseUrl in google provider config when GOOGLE_BASE_URL is unset", async () => {
    delete process.env.GOOGLE_BASE_URL;
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "google_api_key") return "AIza-test-key";
      if (key === "default_provider") return "google";
      return null;
    });

    await regenerateOpenClawConfig();
    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config?.models?.providers?.google?.baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta"
    );
  });

  it("emits an explicit transport api for every built-in provider", async () => {
    // OpenClaw 2026.5.28 changed default-api resolution: a provider with a
    // baseUrl and no explicit `api` falls back to "openai-completions"
    // (resolveConfiguredProviderDefaultApi in provider-policy). Earlier OC
    // inferred the transport from the provider name. That silently broke the
    // built-in google provider — OC POSTed `<baseUrl>/chat/completions`
    // instead of native `:generateContent`, so Smithers replies failed with
    // "provider returned an HTML error page" (FailoverError). anthropic/openai
    // only survived because their model ids still matched OC's catalog
    // discovery — the same latent landmine.
    //
    // Pinchy must emit each built-in provider's canonical transport `api`
    // explicitly so the emitted openclaw.json is self-describing and never
    // depends on OC's inference heuristics. Values mirror OpenClaw's own
    // static provider catalog.
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.GOOGLE_BASE_URL;
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-key";
      if (key === "openai_api_key") return "sk-openai-key";
      if (key === "google_api_key") return "AIza-test-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();
    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config?.models?.providers?.anthropic?.api).toBe("anthropic-messages");
    // Chat Completions, not the Responses API — maximally compatible with
    // OpenAI-compatible proxies behind OPENAI_BASE_URL (see BUILTIN_PROVIDER_API).
    expect(config?.models?.providers?.openai?.api).toBe("openai-completions");
    expect(config?.models?.providers?.google?.api).toBe("google-generative-ai");
  });

  describe("PINCHY_PROVIDER_BASEURL_* takes priority over SDK env vars", () => {
    // These env vars exist for E2E mock injection (Phase 1 of the setup-wizard
    // smoke tests). They override the *_BASE_URL SDK convention so the
    // emitted openclaw.json points OpenClaw at the LLM mock at chat time.
    // Priority: PINCHY_PROVIDER_BASEURL_* > *_BASE_URL > built-in default.
    afterEach(() => {
      delete process.env.PINCHY_PROVIDER_BASEURL_OPENAI;
      delete process.env.PINCHY_PROVIDER_BASEURL_ANTHROPIC;
      delete process.env.PINCHY_PROVIDER_BASEURL_GOOGLE;
      delete process.env.PINCHY_PROVIDER_BASEURL_OLLAMA_CLOUD;
      delete process.env.OPENAI_BASE_URL;
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.GOOGLE_BASE_URL;
    });

    it("emits PINCHY_PROVIDER_BASEURL_OPENAI override into models.providers.openai.baseUrl", async () => {
      process.env.PINCHY_PROVIDER_BASEURL_OPENAI = "http://llm-mock:9100/openai";
      mockedGetSetting.mockImplementation(async (key: string) => {
        if (key === "openai_api_key") return "sk-openai-test";
        return null;
      });

      await regenerateOpenClawConfig();
      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);
      // OpenAI's baseUrl emitted into OC config includes the /v1 suffix
      // (pi-ai appends /chat/completions to it).
      expect(config?.models?.providers?.openai?.baseUrl).toBe("http://llm-mock:9100/openai/v1");
    });

    // Locks the "PINCHY > SDK > built-in default" priority chain for every
    // built-in provider that supports both env vars. Suffix correctness
    // mirrors BUILTIN_PROVIDER_PATH_SUFFIX in build.ts:
    //   openai    → "/v1"
    //   anthropic → ""        (Anthropic SDK URL has no path suffix)
    //   google    → "/v1beta"
    it.each([
      [
        "openai",
        "OPENAI_BASE_URL",
        "PINCHY_PROVIDER_BASEURL_OPENAI",
        "https://sdk-proxy.example.com/v1",
        "http://llm-mock:9100/openai",
        "openai_api_key",
        "sk-openai-test",
        "http://llm-mock:9100/openai/v1",
      ],
      [
        "anthropic",
        "ANTHROPIC_BASE_URL",
        "PINCHY_PROVIDER_BASEURL_ANTHROPIC",
        "https://sdk-anthropic.example.com",
        "http://llm-mock:9100/anthropic",
        "anthropic_api_key",
        "sk-ant-test",
        "http://llm-mock:9100/anthropic",
      ],
      [
        "google",
        "GOOGLE_BASE_URL",
        "PINCHY_PROVIDER_BASEURL_GOOGLE",
        "https://sdk-google.example.com/v1beta",
        "http://llm-mock:9100/google",
        "google_api_key",
        "AIza-test-key",
        "http://llm-mock:9100/google/v1beta",
      ],
    ])(
      "PINCHY override takes priority over SDK env var for %s",
      async (
        provider,
        sdkEnv,
        pinchyEnv,
        sdkValue,
        pinchyValue,
        settingKey,
        keyValue,
        expectedBaseUrl
      ) => {
        process.env[sdkEnv] = sdkValue;
        process.env[pinchyEnv] = pinchyValue;
        mockedGetSetting.mockImplementation(async (key: string) => {
          if (key === settingKey) return keyValue;
          return null;
        });

        await regenerateOpenClawConfig();
        const written = mockedWriteFileSync.mock.calls[0][1] as string;
        const config = JSON.parse(written);
        expect(config?.models?.providers?.[provider]?.baseUrl).toBe(expectedBaseUrl);
      }
    );

    it("SDK env var still works when PINCHY env var is unset (backward compat)", async () => {
      process.env.OPENAI_BASE_URL = "https://sdk-proxy.example.com/v1";
      delete process.env.PINCHY_PROVIDER_BASEURL_OPENAI;
      mockedGetSetting.mockImplementation(async (key: string) => {
        if (key === "openai_api_key") return "sk-openai-test";
        return null;
      });

      await regenerateOpenClawConfig();
      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);
      // SDK env-var value comes through verbatim (no double-suffix).
      expect(config?.models?.providers?.openai?.baseUrl).toBe("https://sdk-proxy.example.com/v1");
    });

    it("emits PINCHY_PROVIDER_BASEURL_ANTHROPIC override with no suffix (Anthropic default has none)", async () => {
      process.env.PINCHY_PROVIDER_BASEURL_ANTHROPIC = "http://llm-mock:9100/anthropic";
      mockedGetSetting.mockImplementation(async (key: string) => {
        if (key === "anthropic_api_key") return "sk-ant-test";
        return null;
      });

      await regenerateOpenClawConfig();
      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);
      // Anthropic default is "https://api.anthropic.com" (no /v1); the
      // override stays bare too.
      expect(config?.models?.providers?.anthropic?.baseUrl).toBe("http://llm-mock:9100/anthropic");
    });

    it("emits PINCHY_PROVIDER_BASEURL_GOOGLE override with /v1beta suffix (Google default has it)", async () => {
      process.env.PINCHY_PROVIDER_BASEURL_GOOGLE = "http://llm-mock:9100/google";
      mockedGetSetting.mockImplementation(async (key: string) => {
        if (key === "google_api_key") return "AIza-test-key";
        return null;
      });

      await regenerateOpenClawConfig();
      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);
      expect(config?.models?.providers?.google?.baseUrl).toBe("http://llm-mock:9100/google/v1beta");
    });

    it("Ollama-Cloud PINCHY override emits into models.providers.ollama-cloud.baseUrl", async () => {
      process.env.PINCHY_PROVIDER_BASEURL_OLLAMA_CLOUD = "http://llm-mock:9100/ollama-cloud";
      mockedGetSetting.mockImplementation(async (key: string) => {
        if (key === "ollama_cloud_api_key") return "sk-ollama-test";
        return null;
      });

      await regenerateOpenClawConfig();
      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);
      expect(config?.models?.providers?.["ollama-cloud"]?.baseUrl).toBe(
        "http://llm-mock:9100/ollama-cloud/v1"
      );
    });
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

  it("should disable OpenClaw's native pre-compaction memory flush", async () => {
    // Pinchy owns memory persistence through the audited, path-scoped
    // `pinchy_write` tool. OpenClaw's built-in pre-compaction memory flush is a
    // second, ungoverned writer for the same capability: it hard-codes the
    // built-in `read`/`write` tools (MEMORY_FLUSH_ALLOWED_TOOL_NAMES), which
    // Pinchy denies via `group:fs` for every agent. The flush therefore runs
    // with zero tools, flails through "tool not found" attempts, and on
    // production silently dropped a user's inbound Telegram receipt. We disable
    // it; the agent journals via `pinchy_write` instead. The flag lives ONLY in
    // agents.defaults.compaction.memoryFlush (no per-agent override exists in
    // OpenClaw), so this is the single lever available.
    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.agents.defaults.compaction.memoryFlush.enabled).toBe(false);
  });

  it("emits a flush-disable that OpenClaw's own resolver actually honors", async () => {
    // Behavior guard against the REAL dependency: feed Pinchy's emitted config to
    // OpenClaw's actual buildMemoryFlushPlan. A non-null plan is what spawned the
    // tool-less flush run that dropped the production Telegram receipt; null means
    // the flush never runs. Key-agnostic: if a future OpenClaw bump changes how the
    // flag is read, this goes red even though our unit assertion above stays green.
    const resolveFlushPlan = await loadOpenClawFlushResolver();

    await regenerateOpenClawConfig();
    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);

    // Pinchy's emitted config disables the flush.
    expect(resolveFlushPlan({ cfg: config })).toBeNull();

    // Baseline that prevents a false green: the SAME config with our flag removed
    // must still produce a plan, proving the null above is caused by our flag and
    // not by some unrelated reason the resolver bailed out.
    const withoutFlag = structuredClone(config);
    delete withoutFlag.agents.defaults.compaction;
    expect(resolveFlushPlan({ cfg: withoutFlag })).not.toBeNull();
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
    // No provider-derived defaults (no model). The memory-flush disable is
    // provider-independent and always present (see dedicated test above).
    expect(config.agents.defaults).toEqual({
      compaction: { memoryFlush: { enabled: false } },
    });
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
          allowedTools: [],
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
      allowed_paths: [
        "/data/hr-docs/",
        "/data/policies/",
        "/root/.openclaw/workspaces/kb-agent-id/uploads",
        "/root/.openclaw/workspaces/kb-agent-id/workbench",
      ],
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
          allowedTools: [],
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
      allowed_paths: [
        "/data/hr-docs/",
        "/root/.openclaw/workspaces/kb-agent-id/uploads",
        "/root/.openclaw/workspaces/kb-agent-id/workbench",
      ],
    });
  });

  it("emits a live-resolved visionModel into pinchy-files config (decoupled from the agent's chat model)", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-files" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));
    // ollama-cloud-only stack: the agent's chat model may be text-only, so the
    // vision model must come from the dedicated live-resolved pick, not the
    // agent model.
    mockedGetSetting.mockImplementation(async (key: string) =>
      key === "ollama_cloud_api_key" ? "test-key" : null
    );
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "kb-agent-id",
          name: "Invoice Reader",
          model: "ollama-cloud/glm-4.7", // text-only chat model
          templateId: "knowledge-base",
          pluginConfig: { "pinchy-files": { allowed_paths: ["/data/invoices/"] } },
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    // Setting a provider key triggers an extra (secrets/profiles) write, so
    // pick the openclaw config write by content (the one carrying `plugins`)
    // rather than assuming a call index.
    const config = mockedWriteFileSync.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[1] as string);
        } catch {
          return null;
        }
      })
      .find((c) => c && c.plugins);
    expect(config.plugins.entries["pinchy-files"].config.visionModel).toBe(
      "ollama-cloud/gemini-3-flash-preview"
    );
  });

  it("injects workspace/uploads into pinchy-files.allowed_paths for every agent", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Test Agent",
          model: "anthropic/claude-opus-4-7",
          createdAt: new Date(),
          allowedTools: [], // NO file tools in allowedTools — workspace inject must still happen
          pluginConfig: { "pinchy-files": { allowed_paths: ["/data/kb"] } },
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const agentConfig = config.plugins.entries["pinchy-files"]?.config?.agents?.["agent-1"];

    expect(agentConfig).toBeDefined();
    expect(agentConfig.allowed_paths).toContain("/data/kb");
    expect(agentConfig.allowed_paths).toContain("/root/.openclaw/workspaces/agent-1/uploads");
  });

  it("injects workspace/uploads even when agent has no pluginConfig", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-2",
          name: "Bare Agent",
          model: "anthropic/claude-opus-4-7",
          createdAt: new Date(),
          allowedTools: [],
          pluginConfig: null,
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const agentConfig = config.plugins.entries["pinchy-files"]?.config?.agents?.["agent-2"];

    expect(agentConfig).toBeDefined();
    expect(agentConfig.allowed_paths).toContain("/root/.openclaw/workspaces/agent-2/uploads");
  });

  it("injects write_paths when pinchy_write is in allowedTools", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "writer",
          name: "Writer Agent",
          model: "anthropic/claude-opus-4-7",
          createdAt: new Date(),
          allowedTools: ["pinchy_write"],
          pluginConfig: null,
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const agentConfig = config.plugins.entries["pinchy-files"]?.config?.agents?.["writer"];

    // workbench/ is the agent's primary write zone. uploads/ stays writable
    // for backward-compat with custom AGENTS.md files that historically told
    // the agent to write there (#418). MEMORY.md (file) + memory/ (dir) are
    // the agent's persistent memory — a write-capable agent gets them too so
    // it can actually persist what it's told to remember.
    expect(agentConfig.write_paths).toEqual([
      "/root/.openclaw/workspaces/writer/uploads",
      "/root/.openclaw/workspaces/writer/workbench",
      "/root/.openclaw/workspaces/writer/MEMORY.md",
      "/root/.openclaw/workspaces/writer/memory",
    ]);
  });

  it("injects workspace/workbench into allowed_paths so pinchy_read can see agent-written files", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "writer",
          name: "Writer Agent",
          model: "anthropic/claude-opus-4-7",
          createdAt: new Date(),
          allowedTools: ["pinchy_write", "pinchy_read"],
          pluginConfig: null,
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const agentConfig = config.plugins.entries["pinchy-files"]?.config?.agents?.["writer"];

    // Subset invariant in validate.ts requires write_paths ⊆ allowed_paths.
    expect(agentConfig.allowed_paths).toContain("/root/.openclaw/workspaces/writer/uploads");
    expect(agentConfig.allowed_paths).toContain("/root/.openclaw/workspaces/writer/workbench");
  });

  it("does not inject write_paths when pinchy_write is not in allowedTools", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "reader",
          name: "Reader Agent",
          model: "anthropic/claude-opus-4-7",
          createdAt: new Date(),
          allowedTools: [],
          pluginConfig: null,
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const agentConfig = config.plugins.entries["pinchy-files"]?.config?.agents?.["reader"];

    expect(agentConfig).toBeDefined();
    expect(agentConfig.write_paths).toBeUndefined();
    // A read-only agent gets no memory paths at all — memory is only writable,
    // so without a write path there's nothing to grant.
    expect(agentConfig.allowed_paths).not.toContain("/root/.openclaw/workspaces/reader/MEMORY.md");
    expect(agentConfig.allowed_paths).not.toContain("/root/.openclaw/workspaces/reader/memory");
  });

  it("grants MEMORY.md + memory/ as writable memory when pinchy_write is present", async () => {
    // The reason agents could never persist memory: group:fs is denied and
    // pinchy_write only covered uploads/ + workbench/. A write-capable agent
    // now gets MEMORY.md (curated long-term) and memory/ (daily logs) so it
    // can actually write what the user tells it to remember.
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "writer",
          name: "Writer Agent",
          model: "anthropic/claude-opus-4-7",
          createdAt: new Date(),
          allowedTools: ["pinchy_write"],
          pluginConfig: null,
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const agentConfig = config.plugins.entries["pinchy-files"]?.config?.agents?.["writer"];

    const memoryFile = "/root/.openclaw/workspaces/writer/MEMORY.md";
    const memoryDir = "/root/.openclaw/workspaces/writer/memory";

    // Writable.
    expect(agentConfig.write_paths).toContain(memoryFile);
    expect(agentConfig.write_paths).toContain(memoryDir);
    // And in allowed_paths to satisfy the subset invariant (write ⊆ allowed).
    expect(agentConfig.allowed_paths).toContain(memoryFile);
    expect(agentConfig.allowed_paths).toContain(memoryDir);

    // Crucial security property: MEMORY.md is granted as a FILE, so the sibling
    // instruction files are NOT writable — the agent can rewrite its memory but
    // never its identity/instructions (validate.ts trailing-slash boundary).
    expect(agentConfig.write_paths).not.toContain("/root/.openclaw/workspaces/writer/SOUL.md");
    expect(agentConfig.write_paths).not.toContain("/root/.openclaw/workspaces/writer/AGENTS.md");
    expect(agentConfig.write_paths).not.toContain("/root/.openclaw/workspaces/writer/IDENTITY.md");
    expect(agentConfig.write_paths).not.toContain("/root/.openclaw/workspaces/writer/USER.md");
  });

  it("never lists the workspace root in allowed_paths or write_paths (hard-deny invariant)", async () => {
    // Regression guard: the workspace root holds Pinchy-managed system files
    // (SOUL.md, AGENTS.md, IDENTITY.md, USER.md). Granting the bare root would
    // let the agent overwrite its own identity. Memory is granted file-granular
    // (MEMORY.md) and dir-granular (memory/) — never the root — so the agent can
    // write its memory but not its instructions. Only uploads/, workbench/,
    // MEMORY.md and memory/ may appear. See #418 acceptance criteria.
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "rooted",
          name: "Rooted Agent",
          model: "anthropic/claude-opus-4-7",
          createdAt: new Date(),
          allowedTools: ["pinchy_write", "pinchy_read"],
          pluginConfig: {
            "pinchy-files": {
              // Even an admin trying to inject the workspace root via admin
              // pluginConfig.allowed_paths is rendered moot by the subset
              // invariant — but the runtime build should also keep things
              // tidy by not echoing the root itself.
              allowed_paths: ["/data/kb/"],
            },
          },
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const agentConfig = config.plugins.entries["pinchy-files"]?.config?.agents?.["rooted"];

    const workspaceRoot = "/root/.openclaw/workspaces/rooted";
    // Neither the bare root nor the root-with-slash may be in either list.
    expect(agentConfig.allowed_paths).not.toContain(workspaceRoot);
    expect(agentConfig.allowed_paths).not.toContain(`${workspaceRoot}/`);
    expect(agentConfig.write_paths).not.toContain(workspaceRoot);
    expect(agentConfig.write_paths).not.toContain(`${workspaceRoot}/`);
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
          allowedTools: [],
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
        "glm-4.7",
        "glm-5",
        "glm-5.1",
        "glm-5.2",
        "gpt-oss:120b",
        "gpt-oss:20b",
        "kimi-k2.5",
        "kimi-k2.6",
        "minimax-m2.1",
        "minimax-m2.5",
        "minimax-m2.7",
        "minimax-m3",
        "ministral-3:14b",
        "ministral-3:3b",
        "ministral-3:8b",
        "mistral-large-3:675b",
        "nemotron-3-nano:30b",
        "nemotron-3-super",
        "nemotron-3-ultra",
        "qwen3-coder-next",
        "qwen3-coder:480b",
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
    // 198K (GLM 4.x/5.x family, minimax-m2.5)
    expect(ctx["glm-4.7"]).toBe(202752);
    expect(ctx["glm-5"]).toBe(202752);
    expect(ctx["glm-5.1"]).toBe(202752);
    expect(ctx["minimax-m2.5"]).toBe(202752);
    // 976K (GLM-5.2 — "NK" = N×1024 → 999424)
    expect(ctx["glm-5.2"]).toBe(999424);
    // 200K (other minimax variants)
    expect(ctx["minimax-m2.1"]).toBe(204800);
    expect(ctx["minimax-m2.7"]).toBe(204800);
    // 256K — the most common class
    expect(ctx["devstral-2:123b"]).toBe(262144);
    expect(ctx["gemma4:31b"]).toBe(262144);
    expect(ctx["kimi-k2.5"]).toBe(262144);
    expect(ctx["kimi-k2.6"]).toBe(262144);
    expect(ctx["ministral-3:3b"]).toBe(262144);
    expect(ctx["ministral-3:8b"]).toBe(262144);
    expect(ctx["ministral-3:14b"]).toBe(262144);
    expect(ctx["mistral-large-3:675b"]).toBe(262144);
    expect(ctx["nemotron-3-super"]).toBe(262144);
    expect(ctx["nemotron-3-ultra"]).toBe(262144);
    expect(ctx["qwen3-coder-next"]).toBe(262144);
    expect(ctx["qwen3-coder:480b"]).toBe(262144);
    expect(ctx["qwen3.5:397b"]).toBe(262144);
    // 384K
    expect(ctx["devstral-small-2:24b"]).toBe(393216);
    // 512K — minimax-m3's guaranteed minimum (library page: "up to 1M")
    expect(ctx["minimax-m3"]).toBe(524288);
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

    // Vision-capable cloud models per the empirical API smoke test in #416
    // (live `/v1/chat/completions` accepts image_url payloads with HTTP 200).
    // devstral-small-2:24b is explicitly excluded — its library page claims
    // "Text, Image" but the runtime API rejects images with HTTP 400.
    const visionModels = [
      "gemini-3-flash-preview",
      "gemma4:31b",
      "kimi-k2.5",
      "kimi-k2.6",
      "minimax-m3",
      "ministral-3:3b",
      "ministral-3:8b",
      "ministral-3:14b",
      "mistral-large-3:675b",
    ];
    for (const id of visionModels) {
      expect(byId[id].input).toEqual(["text", "image"]);
    }
    // Spot-check that text-only models stay text-only (gemma4 was the
    // specific counter-example the user flagged during review). devstral-
    // small-2:24b joined this list after the #416 smoke test demoted it.
    // qwen3.5:397b joined it too: its library page claims image input but the
    // live endpoint hallucinates image contents, so it is flagged text-only.
    expect(byId["rnj-1:8b"].input).toEqual(["text"]);
    expect(byId["qwen3-coder:480b"].input).toEqual(["text"]);
    expect(byId["deepseek-v3.2"].input).toEqual(["text"]);
    expect(byId["devstral-small-2:24b"].input).toEqual(["text"]);
    expect(byId["qwen3.5:397b"].input).toEqual(["text"]);
    // 2026-06 additions: both are text-only lines (no image input tag, and
    // vision is never assumed without an empirical probe).
    expect(byId["nemotron-3-ultra"].input).toEqual(["text"]);
    // glm-5.2: library lists Text-only; live API returns HTTP 400 "does not
    // support image input" (2026-06-17). Text-only like the rest of the GLM line.
    expect(byId["glm-5.2"].input).toEqual(["text"]);

    // Reasoning-capable cloud models per ollama.com/search?c=thinking&c=cloud
    const reasoningModels = [
      "deepseek-v3.1:671b",
      "deepseek-v3.2",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gemini-3-flash-preview",
      "gemma4:31b",
      "glm-4.7",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "gpt-oss:20b",
      "gpt-oss:120b",
      "kimi-k2.5",
      "kimi-k2.6",
      "minimax-m2.5",
      "minimax-m2.7",
      "minimax-m3",
      "nemotron-3-nano:30b",
      "nemotron-3-super",
      "nemotron-3-ultra",
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
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b (7B)",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
      {
        id: "ollama/llama3.2-vision:11b",
        name: "llama3.2-vision:11b (11B)",
        parameterSize: "11B",
        compatible: true,
        capabilities: { tools: true, vision: true, completion: true, thinking: false },
      },
    ]);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama"]).toBeDefined();
    expect(config.models.providers["ollama"].api).toBe("openai-completions");
    expect(config.models.providers["ollama"].models).toHaveLength(2);
    expect(config.models.providers["ollama"].models[0]).toMatchObject({
      id: "qwen2.5:7b",
      // The bare id is used for both `id` and `name`. Switching `name` to
      // Pinchy's display label (m.name = "qwen2.5:7b (7B)") tripped a runtime
      // drift in OpenClaw 2026.4.27 — see build.ts comment for context.
      name: "qwen2.5:7b",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(config.models.providers["ollama"].models[1]).toMatchObject({
      id: "llama3.2-vision:11b",
      name: "llama3.2-vision:11b",
      input: ["text", "image"],
    });
    // contextWindow + maxTokens present and numeric
    expect(typeof config.models.providers["ollama"].models[0].contextWindow).toBe("number");
    expect(typeof config.models.providers["ollama"].models[0].maxTokens).toBe("number");
  });

  it("uses real contextLength from /api/show when present, with maxTokens capped to it", async () => {
    // qwen2.5:7b reports a 32k context, llama3:8b reports 8k. The emitted
    // OpenClaw config should reflect those real values, not a hardcoded
    // default — otherwise every model claims the same window in OpenClaw's UI
    // and small-context models hit ceiling errors below their advertised limit.
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b (7B)",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
        contextLength: 32_768,
      },
      {
        id: "ollama/llama3:8b",
        name: "llama3:8b (8B)",
        parameterSize: "8B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
        contextLength: 8_192,
      },
      {
        id: "ollama/qwen3.5:9b",
        name: "qwen3.5:9b (9B)",
        parameterSize: "9B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
        contextLength: 262_144,
      },
    ]);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const models = config.models.providers["ollama"].models;
    // Real values flow through.
    expect(models[0].contextWindow).toBe(32_768);
    expect(models[1].contextWindow).toBe(8_192);
    expect(models[2].contextWindow).toBe(262_144);
    // maxTokens is capped to min(8192, contextLength) so output never exceeds context.
    expect(models[0].maxTokens).toBe(8_192);
    expect(models[1].maxTokens).toBe(8_192);
    expect(models[2].maxTokens).toBe(8_192);
  });

  it("falls back to default contextWindow when contextLength is missing (older Ollama versions)", async () => {
    // /api/show didn't always include model_info — older Ollama versions
    // omit it. Ensure we still emit a sane default so chat doesn't break.
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b (7B)",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
        // contextLength intentionally absent
      },
    ]);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const models = config.models.providers["ollama"].models;
    expect(typeof models[0].contextWindow).toBe("number");
    expect(models[0].contextWindow).toBeGreaterThan(0);
    expect(typeof models[0].maxTokens).toBe("number");
    expect(models[0].maxTokens).toBeGreaterThan(0);
  });

  it("should include both ollama providers when both are configured", async () => {
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);
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
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434/";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama"].baseUrl).toBe("http://ollama.local:11434/v1");
  });

  it("rewrites host.docker.internal to ollama.local in baseUrl (OpenClaw isLocalBaseUrl allowlist)", async () => {
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama"].baseUrl).toBe("http://ollama.local:11434/v1");
  });

  it("rewrites all known container-host aliases to ollama.local", async () => {
    // The host is exposed under several aliases depending on the runtime:
    // gateway.docker.internal, docker.for.mac.* / docker.for.win.* (legacy
    // Docker Desktop), and docker.orb.internal / host.orb.internal (OrbStack).
    // All are normalized to ollama.local regardless of whether OpenClaw's
    // isLocalBaseUrl happens to accept a given alias today — that's the
    // deliberate decoupling from OpenClaw's host-alias allowlist churn.
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);

    const aliases = [
      "http://gateway.docker.internal:11434",
      "http://docker.for.mac.host.internal:11434",
      "http://docker.for.win.host.internal:11434",
      "http://docker.orb.internal:11434",
      "http://host.orb.internal:11434",
    ];

    for (const url of aliases) {
      mockedWriteFileSync.mockClear();
      mockedGetSetting.mockImplementation(async (key: string) => {
        if (key === "ollama_local_url") return url;
        return null;
      });

      await regenerateOpenClawConfig();

      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);
      expect(config.models.providers["ollama"].baseUrl).toBe("http://ollama.local:11434/v1");
    }
  });

  it("passes through private IPv4 baseUrl unchanged (already in isLocalBaseUrl allowlist)", async () => {
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://192.168.1.50:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama"].baseUrl).toBe("http://192.168.1.50:11434/v1");
  });

  it("passes through localhost / 127.0.0.1 / *.local hostnames unchanged (already on allowlist)", async () => {
    // These all pass OpenClaw's isLocalBaseUrl predicate. Rewriting to
    // ollama.local would be wrong because the user explicitly chose a
    // different host (e.g. mDNS name pointing at a LAN machine). We must
    // preserve their intent.
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);

    const cases = [
      { input: "http://localhost:11434", expected: "http://localhost:11434/v1" },
      { input: "http://127.0.0.1:11434", expected: "http://127.0.0.1:11434/v1" },
      { input: "http://gpu-box.local:11434", expected: "http://gpu-box.local:11434/v1" },
    ];

    for (const { input, expected } of cases) {
      mockedWriteFileSync.mockClear();
      mockedGetSetting.mockImplementation(async (key: string) => {
        if (key === "ollama_local_url") return input;
        return null;
      });

      await regenerateOpenClawConfig();

      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);
      expect(config.models.providers["ollama"].baseUrl).toBe(expected);
    }
  });

  it("is idempotent when user-supplied URL already includes /v1 suffix", async () => {
    // pi-ai's openai-completions provider appends /chat/completions, so the
    // baseUrl must end in /v1 exactly once. If the user already typed /v1
    // (or we re-run regen on an already-rewritten value), we must not
    // double-suffix to /v1/v1.
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434/v1";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama"].baseUrl).toBe("http://ollama.local:11434/v1");
  });

  it("docs option B (Ollama as a sibling Docker service) URL pattern emits a baseUrl OpenClaw accepts (#280 follow-up)", async () => {
    // Mirrors docs/src/content/docs/guides/ollama-setup.mdx options B+C:
    // user adds `ollama.docker.local` as a Docker network alias on their
    // ollama service and sets the URL to `http://ollama.docker.local:11434`.
    // The chosen hostname must:
    //   1. End in `.local` so OpenClaw's isLocalBaseUrl predicate accepts it
    //      (model-auth-CsyLGY9m.js:115 — host.endsWith(".local")).
    //   2. NOT be `ollama.local`. That hostname is mapped to host-gateway in
    //      docker-compose.yml's openclaw `extra_hosts` (for option A), and
    //      `/etc/hosts` wins over Docker DNS aliases on every Linux libc
    //      resolver — so `ollama.local` from inside openclaw resolves to
    //      the host gateway, never to a sibling container.
    // build.ts leaves the URL untouched (it isn't in DOCKER_HOST_ALIASES) and
    // only appends `/v1`. If this assertion ever drifts from the docs, fix
    // the docs or the rewrite — don't weaken the test.
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen3.5:9b",
        name: "qwen3.5:9b",
        parameterSize: "9B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://ollama.docker.local:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const baseUrl = config.models.providers["ollama"].baseUrl;

    expect(baseUrl).toBe("http://ollama.docker.local:11434/v1");
    // Asserts the round-trip property the docs rely on: the URL we tell
    // option-B users to set still passes OpenClaw's local-provider gate.
    expect(mirrorOpenClawIsLocalBaseUrl(baseUrl)).toBe(true);
  });

  it("bare service hostname (e.g. http://ollama:11434) is left untouched and would fail OpenClaw allowlist (#280 docs guard)", async () => {
    // Pre-#280 docs told option-B users to set `http://ollama:11434`. The
    // emitted baseUrl uses the raw service name, which fails OpenClaw's
    // allowlist (no `.local`, not RFC-1918, not loopback) — chats fail with
    // "No API key found for provider 'ollama'" at runtime.
    //
    // build.ts intentionally rewrites only known Docker host aliases
    // (DOCKER_HOST_ALIASES); rewriting bare hostnames would silently
    // misroute legitimate non-local URLs (e.g. http://my-server:11434
    // pointing at a real LAN box). The docs migration to ollama.docker.local
    // is the fix; this test pins the no-rewrite behavior so a future
    // "smarter" rewrite doesn't regress unrelated setups.
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen3.5:9b",
        name: "qwen3.5:9b",
        parameterSize: "9B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://ollama:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const baseUrl = config.models.providers["ollama"].baseUrl;

    expect(baseUrl).toBe("http://ollama:11434/v1");
    // Documents the runtime failure mode bare hostnames would hit: this is
    // why ollama-setup.mdx tells users to alias the service as
    // `ollama.docker.local` (or any `*.local` hostname) instead.
    expect(mirrorOpenClawIsLocalBaseUrl(baseUrl)).toBe(false);
  });

  it("should not add env block for ollama-local provider (URL-based, no API key)", async () => {
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);
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

  it("sets allowPrivateNetwork: true on the ollama-local provider so the OC SSRF guard accepts host.docker.internal / .local / RFC 1918", async () => {
    // OC 2026.5.x ships an SSRF filter that default-denies fetches to RFC
    // 1918 / loopback / .local addresses. The Email/Odoo/Web/Telegram E2E
    // suites — and any real self-hosted Ollama deployment — point the
    // provider at `http://ollama.local:11435` (or host.docker.internal,
    // or 192.168.x.x). Without explicit opt-in, OC blocks every model
    // fetch with `SsrFBlockedError: Blocked hostname or private/internal/
    // special-use IP address`, the run aborts with
    // "LLM request failed: network connection error", and no audit entry
    // is ever written. This assertion locks in the opt-in.
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([
      {
        id: "ollama/llama3.2",
        name: "llama3.2",
        parameterSize: "3B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://ollama.local:11435";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    // Pinchy emits the local Ollama provider under the OC-native key
    // `ollama` (not `ollama-local`) so pi-ai's built-in openai-completions
    // provider handles the stream; the Pinchy-side settings key is
    // `default_provider=ollama-local`.
    // OC's ConfiguredModelProviderRequest schema places allowPrivateNetwork
    // inside the provider's `request` block (sibling of headers/auth/proxy/
    // tls), not directly on the provider config — emitting it at the
    // outer level produces `Unrecognized key` and the gateway refuses to
    // start with "Invalid config at /root/.openclaw/openclaw.json".
    expect(config?.models?.providers?.ollama?.request?.allowPrivateNetwork).toBe(true);
  });

  it("does NOT set allowPrivateNetwork on the public LLM providers (anthropic/openai/google/ollama-cloud)", async () => {
    // The SSRF opt-in is scoped to `ollama-local` because that's the only
    // built-in provider that legitimately targets private / .local / RFC
    // 1918 addresses. Public providers all resolve to TLS-protected
    // public APIs and must stay on the default-deny so a misconfigured
    // URL can't accidentally hit an internal service.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test";
      if (key === "openai_api_key") return "sk-test";
      if (key === "google_api_key") return "gk-test";
      if (key === "ollama_cloud_api_key") return "ol-test";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const providers = config?.models?.providers ?? {};
    for (const name of ["anthropic", "openai", "google", "ollama-cloud"] as const) {
      // The flag must be absent — not `false`, not present at all.
      // eslint-disable-next-line security/detect-object-injection
      expect(providers[name]?.request?.allowPrivateNetwork).toBeUndefined();
      // And no other shape leaks the flag at the outer level either.
      // eslint-disable-next-line security/detect-object-injection
      expect(providers[name]?.allowPrivateNetwork).toBeUndefined();
    }
  });

  it("preserves OC-enriched sibling channels sub-blocks (e.g. channels.defaults) on a real telegram change (#193 follow-up)", async () => {
    // build.ts:1182 spreads `...existingChannels` into the new config.channels
    // when the telegram block changed. Without that spread, OC-side enriched
    // sibling sub-blocks (`channels.defaults` for heartbeat/botLoopProtection,
    // `channels.modelByChannel`, other channels' configs) would get stripped
    // — and since OC 2026.5.x has no `channels` entry in BASE_RELOAD_RULES,
    // the resulting diff falls through to restart-class and re-triggers the
    // very cascade #193 / agent-create-no-restart is supposed to catch.
    // This pin guards against an accidental revert to `{ telegram: ... }`
    // only.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-id-with-bot") return "BOT123:secret";
      return null;
    });
    // Mock an agent in the DB with a telegram bot, plus an OC-enriched
    // `channels.defaults` block already on disk.
    mockedDb.select.mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([
        {
          id: "agent-id-with-bot",
          name: "Bot Agent",
          isPersonal: false,
          ownerId: "user-1",
          createdAt: new Date(),
          deletedAt: null,
        },
      ]),
    } as unknown as ReturnType<typeof mockedDb.select>);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan" },
        channels: {
          defaults: { heartbeat: { mode: "visible" } },
          telegram: { enabled: true, dmPolicy: "pairing", accounts: { "stale-agent": {} } },
        },
      }) as unknown as Buffer
    );

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json.tmp")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(String(written![1]));
    // The OC-enriched sibling sub-block survives the regenerate even though
    // telegram itself changed (accounts swapped from "stale-agent" to the
    // current bot agent).
    expect(config.channels.defaults).toEqual({ heartbeat: { mode: "visible" } });
    expect(config.channels.telegram.accounts).toHaveProperty("agent-id-with-bot");
  });

  it("emits models: [] when fetchOllamaLocalModelsFromUrl returns empty (Ollama unreachable at config-regen time)", async () => {
    // The setup wizard validates that ≥1 tool-capable model exists before
    // saving the URL, so this state means Ollama went away after setup.
    // The empty array leaves the provider block in a known-bad state
    // (OpenClaw 2026.4.27 requires models.length > 0 for the synthetic
    // local key). This test documents the current behavior rather than
    // silently regressing if a future guard is added.
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValue([]);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama"]).toBeDefined();
    expect(config.models.providers["ollama"].models).toEqual([]);
  });

  it("should omit pinchy-context but always include pinchy-files for workspace access", async () => {
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

    // pinchy-context and pinchy-docs are still omitted when no agents use them
    expect(config.plugins.entries["pinchy-context"]).toBeUndefined();
    expect(config.plugins.entries["pinchy-docs"]).toBeUndefined();
    expect(config.plugins.allow).not.toContain("pinchy-context");
    expect(config.plugins.allow).not.toContain("pinchy-docs");
    // pinchy-files is NOW always included (workspace access for every agent)
    expect(config.plugins.entries["pinchy-files"]).toBeDefined();
    expect(config.plugins.allow).toContain("pinchy-files");
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

    // pinchy-files now always has entries (workspace inject) — it should stay in allow
    expect(config.plugins.allow).toContain("pinchy-files");
    // pinchy-odoo has no entries → must be removed from allow
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

  it("exports a single DEFAULT_DOCS_PUBLIC_BASE_URL constant (single source of truth for the hosted-docs default)", () => {
    // Locks in the refactor that removed the duplicated literal between
    // build.ts and the test suite. If the hosted docs domain ever moves,
    // grep for the constant — there must be exactly one definition.
    expect(typeof DEFAULT_DOCS_PUBLIC_BASE_URL).toBe("string");
    expect(DEFAULT_DOCS_PUBLIC_BASE_URL).toMatch(/^https:\/\//);
    expect(DOCS_PUBLIC_BASE_URL_SETTING_KEY).toBe("docs_public_base_url");
  });

  it("defaults pinchy-docs publicBaseUrl to https://docs.heypinchy.com when the setting is unset", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          isPersonal: true,
          ownerId: "user-1",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-docs"].config.publicBaseUrl).toBe(
      DEFAULT_DOCS_PUBLIC_BASE_URL
    );
  });

  it("honours an admin-set docs_public_base_url setting for self-hosted docs", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === DOCS_PUBLIC_BASE_URL_SETTING_KEY) return "https://docs.example.com";
      return null;
    });
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          isPersonal: true,
          ownerId: "user-1",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-docs"].config.publicBaseUrl).toBe(
      "https://docs.example.com"
    );
  });

  it("omits publicBaseUrl when the admin explicitly clears the setting (air-gapped fork)", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === DOCS_PUBLIC_BASE_URL_SETTING_KEY) return "";
      return null;
    });
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          isPersonal: true,
          ownerId: "user-1",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect("publicBaseUrl" in config.plugins.entries["pinchy-docs"].config).toBe(false);
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

  it("can write an E2E-only auth profile for ollama-local when Docker Desktop requires it", async () => {
    process.env.PINCHY_E2E_OLLAMA_LOCAL_API_KEY = "1";
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
      if (key === "ollama_local_url") return "http://host.docker.internal:11435";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("openclaw.json")
    );
    expect(written).toBeDefined();
    const config = JSON.parse(String(written![1]));
    expect(config.models.providers.ollama.apiKey).toEqual({
      source: "file",
      provider: "pinchy",
      id: "/providers/ollama-local/apiKey",
    });

    expect(mockWriteSecretsFile).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          "ollama-local": { apiKey: "dummy-integration-test-key" },
        }),
      })
    );

    const authProfileCall = mockedWriteFileSync.mock.calls.find((call) =>
      String(call[0]).includes("agents/agent-llama/agent/auth-profiles.json")
    );
    expect(authProfileCall).toBeDefined();
    const authProfile = JSON.parse(String(authProfileCall![1]));
    expect(authProfile.profiles["ollama-local-default"]).toEqual({
      type: "api_key",
      provider: "ollama-local",
      keyRef: { kind: "secret", path: "providers.ollama-local.apiKey" },
    });
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

  it("skips the write when openclaw.json is persistently unreadable via EACCES (#314)", async () => {
    // Scenario from issue #314: OC's SIGUSR1 restart toggles openclaw.json to
    // root:0600 longer than `readExistingConfig`'s retry budget (5×100ms +
    // 300ms async retry + 5×100ms = 1.3s). With persistent EACCES the file
    // looks empty to `readExistingConfig`, the spread of every
    // `...existing.<field>` collapses to {}, and the regenerate emits a thin
    // payload that:
    //   - strips `meta` → OC's "missing-meta-before-write" anomaly
    //   - strips `gateway.controlUi.*` OC enrichments
    //   - strips non-pinchy `plugins.entries.*` (telegram, providers)
    //   - drops models.providers when settings reads also race
    //   - drops channels.telegram/bindings/session when DB-derived state
    //     races with the unreadable file
    // → inotify diff cascade (4874 → 2351 size-drop) → full gateway restart.
    //
    // The contract: when the existing file is provably unreadable (EACCES,
    // not ENOENT), regenerate must NOT write a thin payload. Skip the write
    // and rely on the next regenerate (or boot-inits) to heal once the
    // chmod loop restores 0666.
    //
    // We do NOT use fake timers here — `readExistingConfig`'s synchronous
    // busy-wait uses real Date.now() and would hang under fake clocks.
    // The total real-time budget is bounded: 5×100ms busy-wait + 300ms
    // async retry + 5×100ms busy-wait + any extra fix-side budget ≈ ≤ 2s.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockImplementation((path) => {
        if (typeof path === "string" && path.includes("openclaw.json")) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      await regenerateOpenClawConfig();

      // No write to openclaw.json — proceeding with `existing = {}` would
      // have produced the bad thin payload from #314.
      const openclawWrites = mockedWriteFileSync.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
      );
      expect(openclawWrites).toEqual([]);
      // The skip must be loud — silent skips hide the underlying race.
      expect(errorSpy).toHaveBeenCalled();
      const message = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(message).toMatch(/EACCES|unreadable|#314/);
    } finally {
      errorSpy.mockRestore();
    }
  }, 10000);

  describe("config propagation to OpenClaw runtime (#200)", () => {
    // Pinchy must push config changes to OpenClaw's *runtime*, not just
    // disk. The original bug: writing openclaw.json relied on OpenClaw's
    // internal inotify watcher, which on production volumes had ~60 s of
    // pickup latency. Users sending messages right after creating an
    // agent saw `unknown agent id "<uuid>"` because the runtime didn't
    // yet know the agent.
    //
    // Strategy (openclaw#75534 / PR #279): when a WS client is available,
    // config.apply is used exclusively — no prior writeConfigAtomic. This
    // avoids the inotify race: writing the file before config.apply triggers
    // chokidar, which updates currentCompareConfig to the raw Pinchy payload.
    // config.apply then writes a slightly transformed file (OC's merge
    // applies startup-era defaults) → reload handler detects a diff in
    // gateway/discovery/update/canvasHost → restart → ConfigMutationConflictError.
    // When no WS client (or config.apply fails all retries), writeConfigAtomic
    // writes the file directly so inotify picks it up.

    it("writes the config file synchronously on cold start (no WS client)", async () => {
      // Default beforeEach has mockGetClient throwing — cold start path.
      // pushConfigInBackground falls through to writeConfigAtomic synchronously
      // (no await before the write), so the file is on disk before returning.
      await regenerateOpenClawConfig();
      expect(mockedWriteFileSync).toHaveBeenCalled();
    });

    it("uses config.apply (not writeConfigAtomic) when WS client is available", async () => {
      // When a WS client is available, the file write is delegated to config.apply's
      // inner writeConfigFile. Pinchy must NOT call writeConfigAtomic synchronously,
      // as that triggers the inotify race (openclaw#75534).
      mockConfigGet.mockResolvedValue({ hash: "abc123" });
      mockConfigApply.mockResolvedValue(undefined);
      mockGetClient.mockReturnValue({
        config: { get: mockConfigGet, apply: mockConfigApply },
      });

      await regenerateOpenClawConfig();
      await vi.waitFor(() => expect(mockConfigApply).toHaveBeenCalledOnce());
      await drainBackgroundCoroutine();

      // config.apply was used for the write — writeFileSync must NOT have been
      // called with the openclaw.json path (only auth-profiles.json is written).
      const openclawWrite = mockedWriteFileSync.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
      );
      expect(openclawWrite).toBeUndefined();
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
      // succeed even if the runtime push can't be delivered — writeConfigAtomic
      // fires as a fallback after all retries are exhausted.
      mockConfigGet.mockRejectedValue(new Error("Not connected to OpenClaw Gateway"));
      mockGetClient.mockReturnValue({
        config: { get: mockConfigGet, apply: mockConfigApply },
      });

      await expect(regenerateOpenClawConfig()).resolves.not.toThrow();
      // The fallback writeConfigAtomic fires asynchronously after all retry
      // backoffs (~3.5 s total); only verify no throw here.
    });

    it("does not call config.apply at cold start before the OpenClaw client is initialised", async () => {
      // beforeEach sets mockGetClient to throw — exercises the no-client
      // path. The file IS written via writeConfigAtomic but no RPC is attempted.
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

    it("tracks pending state across the push lifecycle (applied, superseded, no-client)", async () => {
      // Under OC 5.3's config.apply rate-limit a push coroutine can be parked
      // 33–53 s; nothing observable said "a config change is still in flight",
      // so E2E stability gates passed and dispatched into the gap (the email
      // dispatch-probe flake). Contract: every pushConfigInBackground call is
      // pending until its coroutine reaches ANY terminal state — applied,
      // superseded, or file-write fallback — and the counter returns to 0.
      _resetConfigPushState();

      // Case 1: applied via WS — pending while config.apply is in flight.
      let resolveApply!: () => void;
      mockConfigGet.mockResolvedValue({ hash: "h1" });
      mockConfigApply.mockImplementation(
        () => new Promise<void>((resolve) => (resolveApply = resolve))
      );
      mockGetClient.mockImplementation(() => ({
        config: { get: mockConfigGet, apply: mockConfigApply },
      }));

      pushConfigInBackground(JSON.stringify({ env: { A: "1" } }));
      expect(getPendingConfigPushCount()).toBe(1);
      await vi.waitFor(() => expect(mockConfigApply).toHaveBeenCalledOnce());
      // Still pending while the apply RPC is unresolved.
      expect(getPendingConfigPushCount()).toBe(1);
      resolveApply();
      await vi.waitFor(() => expect(getPendingConfigPushCount()).toBe(0));

      // Case 2: superseded — BOTH pushes settle (the older via the generation
      // check, the newer via its apply), never leaving a stuck pending count.
      mockConfigApply.mockResolvedValue(undefined);
      pushConfigInBackground(JSON.stringify({ env: { OLD: "1" } }));
      pushConfigInBackground(JSON.stringify({ env: { NEW: "2" } }));
      expect(getPendingConfigPushCount()).toBe(2);
      await vi.waitFor(() => expect(getPendingConfigPushCount()).toBe(0));

      // Case 3: no WS client — synchronous file-write fallback still settles.
      mockGetClient.mockImplementation(() => {
        throw new Error("OpenClaw client not initialized");
      });
      pushConfigInBackground(JSON.stringify({ env: { B: "1" } }));
      await vi.waitFor(() => expect(getPendingConfigPushCount()).toBe(0));
    });

    it("supplements channels.telegram fields absent from payload from OC in-memory config (OC 4.27+ channel diff prevention)", async () => {
      // OC 4.27 writes additional fields to channels.telegram in-memory
      // (e.g. pollingMode, or other new OC-managed fields). Pinchy's payload
      // omits these fields. Without supplement, config.apply sees a channels
      // diff → full gateway restart even for agents-only changes.
      //
      // To exercise this end-to-end through pushConfigInBackground we need
      // the payload to ALSO contain a real change beyond just the supplement
      // merge — otherwise the no-op-apply guard (added to avoid wasting
      // OC 5.3's ~3-per-45 s config.apply rate-limit) would correctly short-
      // circuit before the supplemented payload reaches config.apply. Here
      // the real change is `agents.list` (new); the supplement assertion
      // confirms `pollingMode` gets carried over from OC into the apply'd
      // payload alongside the agents change.
      const ocConfig = {
        meta: { version: "4.27.0", lastTouchedAt: "2025-01-01T00:00:00Z" },
        agents: { list: [] },
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

      // Pinchy's payload has channels.telegram WITHOUT pollingMode AND
      // a brand-new agent — the agent guarantees the supplemented payload
      // diverges from current.config so config.apply actually fires.
      const pinchyPayload = JSON.stringify({
        meta: { version: "4.27.0" },
        agents: { list: [{ id: "agent-new", name: "New" }] },
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

    it("skips config.apply when supplemented payload is semantically equivalent to OC's current config (rate-limit conservation)", async () => {
      // OC 5.3 rate-limits config.apply (~3 per 45 s window). With
      // regenerateOpenClawConfig() running unconditionally on boot AND on
      // every settings/agent mutation, several back-to-back regens can pile
      // up in the rate-limit window — the bootInits-alignment + setup-wizard
      // + connectBot + warmup chain in the Telegram E2E setup is exactly
      // that shape. Each wasted no-op apply consumes a slot and pushes the
      // next legitimate apply over the budget into "rate limit exceeded;
      // retry after Ns".
      //
      // The early-return guard in build.ts compares Pinchy's RAW payload to
      // the file. It can't see the SUPPLEMENTED payload — which is what
      // config.apply actually sends and which often equals OC's runtime even
      // when the raw payload differs (because Pinchy's payload omits OC-
      // managed fields the supplement then re-adds). This guard catches
      // those.
      const ocConfig = {
        meta: { version: "5.3.0", lastTouchedAt: "2026-01-01T00:00:00Z" },
        gateway: { mode: "local", bind: "lan", auth: { token: "tok" } },
        channels: {
          telegram: {
            enabled: true,
            accounts: { a1: { botToken: "tok" } },
            pollingMode: "long_poll",
          },
        },
      };
      mockConfigGet.mockResolvedValue({ hash: "h1", config: ocConfig });
      mockConfigApply.mockResolvedValue(undefined);
      mockGetClient.mockReturnValue({
        config: { get: mockConfigGet, apply: mockConfigApply },
      });

      // Pinchy's payload omits pollingMode (OC-managed) and lastTouchedAt
      // (auto-stamped). After supplement, payload == ocConfig semantically.
      const pinchyPayload = JSON.stringify({
        meta: { version: "5.3.0" },
        gateway: { mode: "local", bind: "lan", auth: { token: "tok" } },
        channels: {
          telegram: {
            enabled: true,
            accounts: { a1: { botToken: "tok" } },
          },
        },
      });

      pushConfigInBackground(pinchyPayload);
      // Drain microtasks so the coroutine reaches and hits the guard.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // No config.apply call — supplement made the payload equivalent to
      // OC's runtime, so we conserved the rate-limit slot.
      expect(mockConfigApply).not.toHaveBeenCalled();
    });

    it("applies config via config.apply even when OC in-memory config and file both lack meta (no obsolete meta-guard)", async () => {
      // Scenario: first-install secrets-bootstrap window — OC's in-memory config
      // has no meta AND the fresh-install file seed has none either, so the
      // supplemented payload lacks meta.
      //
      // The OLD meta-guard returned early to a `writeConfigAtomic` file write
      // here, to dodge OpenClaw 4.27's "missing-meta-before-write" restart
      // cascade. That anomaly is GONE in the pinned OC 2026.5.28 — verified
      // empirically (a meta-less config.apply adding an agent is accepted and
      // hot-reloaded, no restart, agent lands in runtime). The guard was also
      // actively harmful: it shunted every agent-create push onto the file-write
      // path, whose atomic-rename OC's post-restart watcher does not reliably
      // reload, so the agent never reached runtime (#464). So config.apply MUST
      // be used even without meta.
      const ocConfigWithoutMeta = {
        gateway: { mode: "local" },
        plugins: { allow: ["anthropic"], entries: { anthropic: { enabled: true } } },
      };
      mockConfigGet.mockResolvedValue({ hash: "h1", config: ocConfigWithoutMeta });
      mockConfigApply.mockResolvedValue(undefined);
      mockGetClient.mockReturnValue({
        config: { get: mockConfigGet, apply: mockConfigApply },
      });
      // File also has no meta (fresh-install seed / previous meta-less write).
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          gateway: { mode: "local" },
        }) as unknown as Buffer
      );

      await regenerateOpenClawConfig();
      await drainBackgroundCoroutine();

      // config.apply IS called — the meta-less payload applies in-process
      // (reliable) instead of falling back to the watcher-lagged file write.
      expect(mockConfigApply).toHaveBeenCalledTimes(1);
    });

    it("retries config.apply IMMEDIATELY (no backoff) when OC reports stale hash", async () => {
      // Scenario: OpenClaw's file-watcher reloaded `openclaw.json` between
      // our config.get and config.apply, so the hash we sent is stale.
      // OC rejects with `INVALID_REQUEST: config changed since last load;
      // re-run config.get and retry`. This is OC's explicit recovery hint —
      // not a transient network error. Pinchy must refetch the hash and
      // retry the apply WITHOUT waiting through the generic 100/250/500/...ms
      // backoff ladder, otherwise under CI load (slow event loop, blocking
      // sessions.list) the next backoff window can stack with another
      // pushConfigInBackground call and the retry never completes.
      //
      // Test guarantees: with the immediate-retry path, the second apply
      // call happens before any setTimeout fires — we drain microtasks only,
      // never advance fake timers, and still see two apply calls.
      vi.useFakeTimers();
      try {
        mockConfigGet
          .mockResolvedValueOnce({ hash: "h-stale" })
          .mockResolvedValueOnce({ hash: "h-fresh" });
        mockConfigApply
          .mockRejectedValueOnce(
            new Error("config changed since last load; re-run config.get and retry")
          )
          .mockResolvedValueOnce(undefined);
        mockGetClient.mockReturnValue({
          config: { get: mockConfigGet, apply: mockConfigApply },
        });

        pushConfigInBackground(JSON.stringify({ env: { X: "1" } }));

        // Drain microtasks repeatedly without advancing timers. With the
        // immediate-retry fix, the chain config.get → config.apply (fail) →
        // refetch get → retry apply (success) settles entirely in microtasks.
        // Without the fix, the retry path hits `setTimeout(100ms)` and the
        // second apply never happens until we advance timers.
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(0);
        }

        expect(mockConfigApply).toHaveBeenCalledTimes(2);
        expect(mockConfigApply.mock.calls[1][1]).toBe("h-fresh");
      } finally {
        vi.useRealTimers();
      }
    });

    it("limits stale-hash immediate retries to a small budget (no infinite loop)", async () => {
      // If OpenClaw is genuinely stuck (every config.get → apply round-trip
      // races a file-watcher reload), Pinchy must NOT spin forever. Cap the
      // immediate-retry budget at 3 so the function returns within tens of
      // milliseconds and inotify takes over as the safety net.
      vi.useFakeTimers();
      try {
        mockConfigGet.mockResolvedValue({ hash: "h-stale" });
        mockConfigApply.mockRejectedValue(
          new Error("config changed since last load; re-run config.get and retry")
        );
        mockGetClient.mockReturnValue({
          config: { get: mockConfigGet, apply: mockConfigApply },
        });

        pushConfigInBackground(JSON.stringify({ env: { X: "1" } }));

        // Drain microtasks without advancing timers (so generic backoff
        // does NOT contribute). All immediate retries should fire here.
        for (let i = 0; i < 20; i++) {
          await vi.advanceTimersByTimeAsync(0);
        }

        // Cap: at most 3 immediate retries on the stale-hash error before
        // bailing out (so 1 initial + 3 retries = 4 calls, max).
        expect(mockConfigApply.mock.calls.length).toBeLessThanOrEqual(4);
        expect(mockConfigApply.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("waits past the WS-disconnected window before the inotify fallback", async () => {
      // Scenario: a successful config.apply triggered SIGUSR1 in OC; OC is now
      // restarting in-process and the WS is dropped. config.get() rejects
      // with "Not connected to OpenClaw Gateway" on each retry. The default
      // 3.85 s backoff is shorter than any plausible OC restart, and the
      // resulting writeConfigAtomic races OC's startup-time
      // `ensureGatewayStartupAuth → replaceConfigFile` (Telegram E2E
      // `agent-create-no-restart.spec.ts` cascade — file hash changes mid-
      // restart, OC fails startup with ConfigMutationConflictError).
      // The fix: extend the budget to 30 s for "Not connected" specifically,
      // so the WS reconnect during the restart lands the apply via the next
      // config.apply rather than via inotify-into-restart.
      // This test simulates the OC restart resolving partway through the
      // 30 s budget: config.get() rejects for the first ~6 s, then a
      // simulated reconnect makes config.apply succeed, and we assert that
      // no file write happened.
      vi.useFakeTimers();
      try {
        // Fail with "Not connected" 3 times (3 × 2 s = 6 s of restart),
        // then succeed (OC came back).
        mockConfigGet
          .mockRejectedValueOnce(new Error("Not connected to OpenClaw Gateway"))
          .mockRejectedValueOnce(new Error("Not connected to OpenClaw Gateway"))
          .mockRejectedValueOnce(new Error("Not connected to OpenClaw Gateway"))
          .mockResolvedValue({
            hash: "h-after-restart",
            config: {
              meta: { version: "5.3.0", lastTouchedAt: "2026-01-01T00:00:00Z" },
              gateway: { mode: "local", bind: "lan", auth: { token: "tok" } },
            },
          });
        mockConfigApply.mockResolvedValue(undefined);
        mockGetClient.mockReturnValue({
          config: { get: mockConfigGet, apply: mockConfigApply },
        });

        pushConfigInBackground(JSON.stringify({ env: { X: "1" } }));

        // Each retry sleeps NOT_CONNECTED_RETRY_DELAY_MS = 2000 ms before
        // calling config.get() again. Advance through the 6 s restart.
        for (let i = 0; i < 4; i++) {
          await vi.advanceTimersByTimeAsync(2_100);
        }
        // Drain remaining microtasks for the successful apply.
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(0);
        }

        // config.apply succeeded after the 4th config.get() resolved —
        // delivered via WS, no inotify file write.
        expect(mockConfigApply).toHaveBeenCalledTimes(1);
        const openclawWrite = mockedWriteFileSync.mock.calls.find(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
        );
        expect(
          openclawWrite,
          "writeFileSync must NOT be called for openclaw.json when WS reconnects within the 30 s budget"
        ).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a WS-disconnect-waiting coroutine when a newer pushConfigInBackground call starts", async () => {
      // Coverage backfill for the layered-guardrails rule: the existing
      // `cancels pending retries when a newer pushConfigInBackground call starts`
      // test only exercises the apply-retry path. With the OC 5.3 cascade fix
      // we added a second sleep path — the WS-disconnect 30 s extended wait
      // (`NOT_CONNECTED_MAX_WAIT_MS` in write.ts). The generation check at the
      // top of the for-loop runs after each `continue` from that branch, so
      // cancellation should work the same way; this test pins that behavior
      // so a future refactor of the WS-disconnect wait (e.g. the `i--`
      // pattern flagged in code review) can't silently drop the cancellation.
      vi.useFakeTimers();
      try {
        // Both coroutines hit "Not connected" forever — keeps coroutine 2 in
        // the WS-disconnect retry loop long enough to exhaust its 30 s budget
        // and surface the file-write fallback. If coroutine 1 was NOT
        // cancelled, we would see TWO file writes (one OLD, one NEW); the
        // cancellation guarantee means we see exactly ONE, with the NEW
        // payload.
        mockConfigGet.mockRejectedValue(new Error("Not connected to OpenClaw Gateway"));
        mockGetClient.mockReturnValue({
          config: { get: mockConfigGet, apply: mockConfigApply },
        });
        // readFileSync (used by supplementPayloadWithFileFields in the fallback
        // path) must return a parseable config so the file-write fallback
        // succeeds rather than throwing.
        mockedReadFileSync.mockReturnValue(
          JSON.stringify({
            meta: { version: "5.3.0", lastTouchedAt: "2026-01-01T00:00:00Z" },
            gateway: { mode: "local", bind: "lan", auth: { token: "tok" } },
          }) as unknown as Buffer
        );

        // Start coroutine 1 (OLD). Its first config.get() rejects on the next
        // microtask; it enters the 2 s WS-disconnect sleep.
        pushConfigInBackground(JSON.stringify({ env: { OLD: "1" } }));
        // Immediately start coroutine 2 (NEW). Synchronously increments
        // _pushGeneration from 1 to 2 BEFORE coroutine 1's sleep ends.
        pushConfigInBackground(JSON.stringify({ env: { NEW: "2" } }));

        // Advance past coroutine 2's 30 s budget plus the final retry slot.
        for (let i = 0; i < 35; i++) {
          await vi.advanceTimersByTimeAsync(2_100);
        }
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(0);
        }

        // Find every openclaw.json file write (the atomic rename target;
        // .tmp writes show up as separate calls).
        const openclawWrites = mockedWriteFileSync.mock.calls.filter(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
        );

        // The .tmp + final path each show up — but only from ONE coroutine.
        // If the cancellation broke, we would see writes from both coroutines.
        // The decisive check is the payload content: it must be the NEW
        // payload, never the OLD.
        const oldWrites = openclawWrites.filter((c) => String(c[1]).includes('"OLD"'));
        const newWrites = openclawWrites.filter((c) => String(c[1]).includes('"NEW"'));
        expect(
          oldWrites.length,
          "OLD payload must NEVER be written — coroutine 1 was superseded before its WS-disconnect sleep ended"
        ).toBe(0);
        expect(
          newWrites.length,
          "NEW payload must be written via the WS-disconnect 30 s budget fallback"
        ).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to inotify after the 30 s WS-disconnected budget exhausts", async () => {
      // Scenario: OC is genuinely down (not just restarting). config.get()
      // keeps rejecting with "Not connected" past the 30 s extended budget.
      // We must eventually fall back to writeConfigAtomic so the change
      // reaches OC whenever it does come back — losing the update silently
      // is worse than the inotify race that originally motivated the
      // extended budget.
      vi.useFakeTimers();
      try {
        const existingOcConfig = {
          meta: { version: "5.3.0", lastTouchedAt: "2026-01-01T00:00:00Z" },
          gateway: { mode: "local", bind: "lan", auth: { token: "tok" } },
        };
        mockConfigGet.mockRejectedValue(new Error("Not connected to OpenClaw Gateway"));
        mockGetClient.mockReturnValue({
          config: { get: mockConfigGet, apply: mockConfigApply },
        });
        mockedReadFileSync.mockReturnValue(JSON.stringify(existingOcConfig) as unknown as Buffer);

        pushConfigInBackground(JSON.stringify({ env: { X: "1" } }));

        // Advance past 30 s budget + final backoff slot (2 s) + safety.
        for (let i = 0; i < 35; i++) {
          await vi.advanceTimersByTimeAsync(2_100);
        }
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(0);
        }

        // config.apply was never called — every config.get() rejected.
        expect(mockConfigApply).not.toHaveBeenCalled();
        // After the budget exhausted, the file fallback fired.
        const openclawWrite = mockedWriteFileSync.mock.calls.find(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
        );
        expect(
          openclawWrite,
          "writeFileSync MUST be called for openclaw.json once the 30 s budget is exhausted (OC is genuinely down)"
        ).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries config.apply via WS after the rate-limit window instead of dropping the change", async () => {
      // Scenario: OC 5.3 rejects the apply with "rate limit exceeded for
      // config.apply; retry after Ns" (e.g. several back-to-back regens piled
      // into one window). The OLD behaviour returned immediately on rate-limit
      // ("OC already has the correct config in memory"), but that assumption is
      // false for a GENUINE pending change: the no-op guard above already
      // returns for semantically-equivalent configs, so a rate-limited apply
      // ALWAYS carries a real diff. Dropping it silently lost newly-created
      // agents — OC's runtime never learned about them and rejected chat
      // dispatch with `unknown agent id` indefinitely (the Odoo/email/web
      // dispatch-probe flake; CI run 26837712634).
      //
      // The fix: wait out the advertised window, then RETRY the same clean WS
      // config.apply path. No file write on this path → no inotify drift (the
      // original reason for skipping the write is preserved).
      vi.useFakeTimers();
      try {
        mockConfigGet.mockResolvedValue({ hash: "h1" });
        mockConfigApply
          .mockRejectedValueOnce(new Error("rate limit exceeded for config.apply; retry after 2s"))
          .mockResolvedValueOnce(undefined);
        mockGetClient.mockReturnValue({
          config: { get: mockConfigGet, apply: mockConfigApply },
        });

        pushConfigInBackground(JSON.stringify({ env: { X: "1" } }));

        // First apply fires and is rate-limited.
        await vi.advanceTimersByTimeAsync(0);
        expect(mockConfigApply).toHaveBeenCalledTimes(1);

        // No file write yet — we wait out the window on the clean WS path,
        // we do NOT fall back to disk (which would cause inotify drift).
        let openclawWrite = mockedWriteFileSync.mock.calls.find(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
        );
        expect(
          openclawWrite,
          "must NOT file-write before the WS retry budget is exhausted"
        ).toBeUndefined();

        // Advance past the advertised 2 s window (plus the buffer). The retry
        // fires a fresh config.get + config.apply, which now succeeds.
        await vi.advanceTimersByTimeAsync(4_000);

        expect(mockConfigApply).toHaveBeenCalledTimes(2);
        // Still no file write — the change was delivered cleanly over WS.
        openclawWrite = mockedWriteFileSync.mock.calls.find(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
        );
        expect(
          openclawWrite,
          "writeFileSync must NOT be called when the WS retry succeeds"
        ).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to a file write only after the rate-limit retry budget is exhausted", async () => {
      // If OC keeps rate-limiting us across multiple windows, the pending
      // change must STILL reach OC's runtime — a late, slightly-drifted config
      // (inotify reload adds built-in plugin entries / reorders keys) is
      // strictly better than a permanently-lost agent. After the bounded WS
      // retry budget, fall back to writeConfigAtomic so OC's file-watcher picks
      // the change up. This is the safety net the old "drop and hope the next
      // apply delivers it" code lacked — there is no guaranteed next apply.
      vi.useFakeTimers();
      try {
        mockConfigGet.mockResolvedValue({ hash: "h1" });
        // Always rate-limited — exhaust the retry budget.
        mockConfigApply.mockRejectedValue(
          new Error("rate limit exceeded for config.apply; retry after 1s")
        );
        mockGetClient.mockReturnValue({
          config: { get: mockConfigGet, apply: mockConfigApply },
        });

        pushConfigInBackground(JSON.stringify({ env: { X: "1" } }));

        // Drive through the initial apply + all bounded rate-limit retries.
        // Generous advance covers every window-wait plus buffer.
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(5_000);
        }

        // The change was NOT lost — it landed on disk for the file-watcher.
        const openclawWrite = mockedWriteFileSync.mock.calls.find(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
        );
        expect(
          openclawWrite,
          "writeConfigAtomic must run as the last-resort fallback so the change is not lost"
        ).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a pending rate-limit retry when a newer push starts", async () => {
      // The retry sleeps out the rate-limit window. If a newer
      // pushConfigInBackground call starts during that sleep, the stale retry
      // must abort at the generation check rather than firing config.apply
      // with an outdated payload on top of the newer one.
      vi.useFakeTimers();
      try {
        mockConfigGet.mockResolvedValue({ hash: "h1" });
        mockConfigApply.mockRejectedValue(
          new Error("rate limit exceeded for config.apply; retry after 2s")
        );
        mockGetClient.mockReturnValue({
          config: { get: mockConfigGet, apply: mockConfigApply },
        });

        pushConfigInBackground(JSON.stringify({ env: { OLD: "1" } }));
        // First apply fires and is rate-limited; the coroutine now sleeps.
        await vi.advanceTimersByTimeAsync(0);
        expect(mockConfigApply).toHaveBeenCalledTimes(1);

        // A newer push bumps the generation while the first is mid-sleep.
        mockConfigApply.mockReset();
        mockConfigApply.mockResolvedValue(undefined);
        pushConfigInBackground(JSON.stringify({ env: { NEW: "2" } }));

        // Advance past the first push's retry window. Its retry must NOT fire
        // — it returns at the generation check. Only the NEW push's apply runs.
        await vi.advanceTimersByTimeAsync(4_000);

        const oldPayloadApplied = mockConfigApply.mock.calls.some((c) =>
          String(c[0]).includes('"OLD"')
        );
        expect(oldPayloadApplied, "stale OLD payload must not be applied after a newer push").toBe(
          false
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses generic backoff (not the stale-hash bypass) for unrelated config.apply errors", async () => {
      // Regression guard: only the OC-specific "config changed since last
      // load" message gets the immediate-refetch path. Any other error
      // (transient WS, INTERNAL_ERROR, generic network failure) must keep
      // going through the existing exponential-backoff loop, otherwise we
      // risk hammering OC during real outages.
      vi.useFakeTimers();
      try {
        mockConfigGet.mockResolvedValue({ hash: "h1" });
        mockConfigApply
          .mockRejectedValueOnce(new Error("WebSocket disconnected"))
          .mockResolvedValueOnce(undefined);
        mockGetClient.mockReturnValue({
          config: { get: mockConfigGet, apply: mockConfigApply },
        });

        pushConfigInBackground(JSON.stringify({ env: { X: "1" } }));

        // Drain microtasks first — initial apply fires and rejects.
        for (let i = 0; i < 5; i++) {
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(mockConfigApply).toHaveBeenCalledTimes(1);

        // Without timer advance, the second apply MUST NOT fire — the
        // generic-error path waits backoffsMs[0] = 100ms.
        // Now advance past the first backoff and the retry happens.
        await vi.advanceTimersByTimeAsync(150);

        expect(mockConfigApply).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
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

describe("seedRestartClassOverridesIfMissing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("writes overrides when the file is empty / missing all four fields", () => {
    // Bind-mount-empty scenario: e.g. Pinchy on the host writing into
    // /tmp/pinchy-integration-openclaw before OC's first start, where the
    // bind-mount target doesn't carry the image's baked-in config.
    mockedReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const changed = seedRestartClassOverridesIfMissing();

    expect(changed).toBe(true);
    const writtenAtomic = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json.tmp")
    );
    expect(writtenAtomic).toBeDefined();
    const written = JSON.parse(String(writtenAtomic![1]));
    expect(written.gateway?.controlUi?.enabled).toBe(false);
    // allowedOrigins must be seeded too: OpenClaw enriches it in memory only,
    // so leaving it absent makes every later regenerate drop it and trigger a
    // restart-class diff.
    expect(written.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
    expect(written.discovery?.mdns?.mode).toBe("off");
    expect(written.update?.checkOnStart).toBe(false);
    expect(written.canvasHost?.enabled).toBe(false);
  });

  it("returns false (no write) when file already has all overrides — production case", () => {
    // Production case: Docker-managed named volume populated from the image's
    // baked-in `config/openclaw.json` already carries these. No write needed.
    const existing = {
      gateway: {
        mode: "local",
        bind: "lan",
        controlUi: {
          enabled: false,
          allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
        },
      },
      discovery: { mdns: { mode: "off" } },
      update: { checkOnStart: false },
      canvasHost: { enabled: false },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existing) as unknown as Buffer);

    const changed = seedRestartClassOverridesIfMissing();

    expect(changed).toBe(false);
    const writtenAtomic = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json.tmp")
    );
    expect(writtenAtomic).toBeUndefined();
  });

  it("seeds controlUi.allowedOrigins when the file disables controlUi but omits it (upgrade case)", () => {
    // Pre-2026.5.28 Pinchy wrote controlUi.enabled=false WITHOUT allowedOrigins.
    // On upgrade, OpenClaw seeds allowedOrigins in memory only; if Pinchy never
    // persists it, the next regenerate drops the field and OC restarts. The seed
    // must add it even when the other four overrides are already correct.
    const existing = {
      gateway: { mode: "local", bind: "lan", controlUi: { enabled: false } },
      discovery: { mdns: { mode: "off" } },
      update: { checkOnStart: false },
      canvasHost: { enabled: false },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existing) as unknown as Buffer);

    const changed = seedRestartClassOverridesIfMissing();

    expect(changed).toBe(true);
    const writtenAtomic = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json.tmp")
    );
    const written = JSON.parse(String(writtenAtomic![1]));
    expect(written.gateway.controlUi.enabled).toBe(false);
    expect(written.gateway.controlUi.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
  });

  it("preserves existing fields outside the four restart-class paths", () => {
    // Don't clobber other Pinchy/OC state — only flip the four restart-class
    // overrides. The agents/plugins/secrets/models blocks must round-trip
    // unchanged.
    const existing = {
      meta: { version: "5.3.0", lastTouchedAt: "T1" },
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { mode: "token", token: "preserved-token" },
        controlUi: { enabled: true, allowedOrigins: ["http://localhost:18789"] },
      },
      discovery: { mdns: { mode: "auto" } }, // OC default — needs flip
      // update + canvasHost missing entirely
      agents: { list: [{ id: "preserved-agent", name: "Preserved" }] },
      plugins: { allow: ["pinchy-audit"], entries: { "pinchy-audit": { enabled: true } } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existing) as unknown as Buffer);

    seedRestartClassOverridesIfMissing();

    const writtenAtomic = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json.tmp")
    );
    const written = JSON.parse(String(writtenAtomic![1]));

    // Restart-class overrides flipped to Pinchy values:
    expect(written.gateway.controlUi.enabled).toBe(false);
    expect(written.discovery.mdns.mode).toBe("off");
    expect(written.update.checkOnStart).toBe(false);
    expect(written.canvasHost.enabled).toBe(false);

    // Non-restart-class fields preserved byte-for-byte:
    expect(written.meta).toEqual(existing.meta);
    expect(written.gateway.mode).toBe("local");
    expect(written.gateway.bind).toBe("lan");
    expect(written.gateway.auth).toEqual(existing.gateway.auth);
    expect(written.gateway.controlUi.allowedOrigins).toEqual(["http://localhost:18789"]);
    expect(written.agents).toEqual(existing.agents);
    expect(written.plugins).toEqual(existing.plugins);
  });
});

describe("seedGatewayTokenIfMissing", () => {
  // Background: OC 2026.5.12+ strictly requires gateway.auth.token in
  // openclaw.json before it will bind on a non-loopback interface (log line:
  // "Refusing to bind gateway to lan without auth"). Earlier OC versions
  // self-bootstrapped a random token at first start when the field was
  // missing. With the new strict check, the OC container fails to start on
  // a fresh install (no setup wizard run yet) because no upstream writer
  // ever lands a token in the config — Pinchy gates regenerateOpenClawConfig()
  // behind isSetupComplete() and the wizard hasn't run.
  //
  // seedGatewayTokenIfMissing() closes this gap: it runs unconditionally in
  // bootInits() and lands gateway.auth.token = (DB token or freshly generated)
  // before markOpenClawConfigReady() unblocks the OC compose dependency.
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedGetSetting.mockResolvedValue(null);
  });

  it("writes gateway.auth.token AND auth.mode='token' when the file is empty / missing", async () => {
    // Fresh-install scenario: bind-mount target is empty (no baked-in config
    // got through), so the file doesn't exist yet. OC would refuse to start
    // until the wizard runs — except we seed the token here.
    //
    // Critically, we must seed `mode: "token"` together with the token.
    // Without it, the post-wizard regenerateOpenClawConfig() (which always
    // writes `auth: { mode: "token", token }`) produces a restart-class diff
    // at `gateway.auth.mode`, which forces an OC gateway restart that drops
    // all lazy pinchy-* plugins from the runtime (only `onStartup: true`
    // plugins survive). Matching the wizard's auth shape byte-for-byte at
    // seed time keeps the eventual post-wizard write a no-op restart-wise.
    mockedReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const changed = await seedGatewayTokenIfMissing();

    expect(changed).toBe(true);
    const writtenAtomic = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json.tmp")
    );
    expect(writtenAtomic).toBeDefined();
    const written = JSON.parse(String(writtenAtomic![1]));
    expect(typeof written.gateway?.auth?.token).toBe("string");
    expect(written.gateway.auth.token.length).toBeGreaterThan(0);
    expect(written.gateway.auth.mode).toBe("token");
  });

  it("returns false (no write) when the token is already present", async () => {
    // Existing-install scenario: regenerateOpenClawConfig() has already
    // landed a token (post-wizard), or a previous bootInits() call already
    // seeded one. Don't churn the file.
    const existing = {
      gateway: { mode: "local", bind: "lan", auth: { token: "already-seeded-xyz" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existing) as unknown as Buffer);

    const changed = await seedGatewayTokenIfMissing();

    expect(changed).toBe(false);
    const writtenAtomic = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json.tmp")
    );
    expect(writtenAtomic).toBeUndefined();
  });

  it("preserves existing fields outside gateway.auth.token", async () => {
    // Don't clobber other Pinchy/OC state — only land gateway.auth.token.
    // The file may already carry restart-class overrides written by
    // seedRestartClassOverridesIfMissing() in the same boot pass.
    const existing = {
      gateway: {
        mode: "local",
        bind: "lan",
        controlUi: { enabled: false },
      },
      discovery: { mdns: { mode: "off" } },
      update: { checkOnStart: false },
      canvasHost: { enabled: false },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existing) as unknown as Buffer);

    await seedGatewayTokenIfMissing();

    const writtenAtomic = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json.tmp")
    );
    const written = JSON.parse(String(writtenAtomic![1]));

    // Token landed with full auth shape (mode + token) to avoid the
    // gateway.auth.mode restart-class diff from the eventual post-wizard
    // regenerateOpenClawConfig() write:
    expect(typeof written.gateway.auth?.token).toBe("string");
    expect(written.gateway.auth.token.length).toBeGreaterThan(0);
    expect(written.gateway.auth.mode).toBe("token");

    // Other restart-class fields and gateway settings preserved:
    expect(written.gateway.mode).toBe("local");
    expect(written.gateway.bind).toBe("lan");
    expect(written.gateway.controlUi.enabled).toBe(false);
    expect(written.discovery.mdns.mode).toBe("off");
    expect(written.update.checkOnStart).toBe(false);
    expect(written.canvasHost.enabled).toBe(false);
  });

  it("refuses to write when readExistingConfig throws EACCES (avoids clobbering enriched OC state during chmod race, #314)", async () => {
    // OC's SIGUSR1 restart pipeline rewrites openclaw.json as root 0600;
    // start-openclaw.sh's tight chmod loop reopens it to 0666 within
    // ~50 ms, but Pinchy (uid 999) can hit a window where read fails with
    // EACCES even though the file holds a fully-populated post-wizard
    // config. Catching that and seeding `{gateway: {auth: {token}}}` over
    // an empty `existing` would erase every OC-enriched block on disk —
    // exactly the regression integration test #00 ("PATCH agent with no
    // DB change must not modify openclaw.json") guards against. Skip
    // the seed in that case; the next bootInits run or the post-wizard
    // regenerate heals once chmod catches up.
    mockedReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });

    const changed = await seedGatewayTokenIfMissing();

    expect(changed).toBe(false);
    const writtenAtomic = mockedWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json.tmp")
    );
    expect(writtenAtomic).toBeUndefined();
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

  it("updateTelegramChannelConfig calls restartState.notifyRestart when channels.telegram changes", async () => {
    // channels.telegram mutations always trigger a full OC restart (inotify),
    // unlike regenerateOpenClawConfig where most blocks hot-reload. The notify
    // must fire so /api/health/openclaw returns "restarting" and the client
    // overlay stays visible until OC's Telegram polling is actually back up.
    const { restartState } = await import("@/server/restart-state");
    mockedReadFileSync.mockReturnValue(JSON.stringify({ gateway: { mode: "local", bind: "lan" } }));

    updateTelegramChannelConfig("agent-99", { botToken: "tg-secret-token" });

    expect(mockedWriteFileSync).toHaveBeenCalled();
    expect(restartState.notifyRestart).toHaveBeenCalledOnce();
  });

  it("updateTelegramChannelConfig does NOT call restartState.notifyRestart when content is unchanged (dedup)", async () => {
    // No actual config write = no inotify event = no OC restart. Spurious
    // notifyRestart would block the UI behind the overlay for 30 s for nothing.
    const { restartState } = await import("@/server/restart-state");

    // First write produces canonical content
    mockedReadFileSync.mockReturnValue(JSON.stringify({ gateway: { mode: "local", bind: "lan" } }));
    updateTelegramChannelConfig("agent-99", { botToken: "tg-secret-token" });
    const firstWrite = mockedWriteFileSync.mock.calls[0][1] as string;

    vi.clearAllMocks();
    // Second call with identical resulting content — dedup should kick in
    mockedReadFileSync.mockReturnValue(firstWrite);

    updateTelegramChannelConfig("agent-99", { botToken: "tg-secret-token" });

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
        // callCount 4 = integrationConnections for mcp (chained with where, returns [])
        // callCount 5 = channel_links table: both users linked
        if (callCount === 5) {
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

  it("should NOT emit session.identityLinks even when channel_links exist (#508 per-task sessions)", async () => {
    // #508: We moved to a PER-TASK session model — web and Telegram are now
    // SEPARATE OpenClaw sessions. Emitting `session.identityLinks` made
    // OpenClaw fold a linked Telegram peer's DMs into the SAME session as the
    // user's web chat (`agent:<id>:direct:<userId>`), which is what let a
    // Telegram `/new` wipe the web history and prevented Telegram from showing
    // as its own chat. Removing the identityLinks emission gives each Telegram
    // peer its own per-peer session (`agent:<id>:direct:<peerId>`), surfaced as
    // a read-only "Telegram" chat by the Chats list (attributed via
    // channel_links). This is a DELIBERATE behaviour change: the unification
    // was the bug. `dmScope: "per-peer"`, the reset override, and the per-user
    // peer bindings (which route DMs to the right personal agent) must stay.
    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: agents table — personal agent so a per-user peer
          // binding is generated for the linked user.
          return Object.assign(
            Promise.resolve([
              {
                id: "agent-1",
                name: "Smithers",
                model: "m",
                allowedTools: [],
                isPersonal: true,
                ownerId: "user-1",
              },
            ]),
            { innerJoin: mockInnerJoin([]), where: vi.fn().mockResolvedValue([]) }
          );
        }
        // callCount 2 = agentConnectionPermissions (chained with innerJoin)
        // callCount 3 = integrationConnections for web-search (chained with where)
        // callCount 4 = integrationConnections for mcp (chained with where, returns [])
        // callCount 5 = channel_links table
        if (callCount === 5) {
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

    // identityLinks must NOT be emitted (#508).
    expect(config.session.identityLinks).toBeUndefined();
    // dmScope and the daily-reset override are still Pinchy-owned and stay.
    expect(config.session.dmScope).toBe("per-peer");
    expect(config.session.reset).toEqual({ mode: "idle", idleMinutes: 525600 });
    // Per-user peer binding still routes the linked user's DMs to their agent.
    expect(config.bindings).toEqual(
      expect.arrayContaining([
        {
          agentId: "agent-1",
          match: {
            channel: "telegram",
            accountId: "agent-1",
            peer: { kind: "dm", id: "999888" },
          },
        },
      ])
    );
  });

  it("PURGES a stale session.identityLinks already on disk on regenerate (#508 upgrade path)", async () => {
    // THE UPGRADE SCENARIO. The cold-start test above only proves we no longer
    // EMIT identityLinks from scratch. But prod/demo installs that ran a
    // pre-per-task version already have `session.identityLinks` baked into
    // openclaw.json (it was written for every linked Telegram user). Commit
    // 2517a0fb stopped writing it but does NOT remove a pre-existing one:
    // regenerate spreads the on-disk `session` block, so a stale identityLinks
    // rides along forever → OpenClaw keeps unifying Telegram with the web
    // session → the #508 footgun stays UNFIXED on exactly the deployments that
    // have it. The fix must actively PURGE the key, not just stop writing it.
    //
    // We purge ONLY identityLinks — any other foreign session key OpenClaw may
    // have stamped is preserved (same denylist philosophy as the channels
    // block above).
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "secret" } },
      session: {
        // Stale Pinchy-written unification link from before the per-task model.
        identityLinks: { "user-1": ["telegram:999"] },
        // Pinchy-owned reset override that must survive.
        reset: { mode: "idle", idleMinutes: 525600 },
        // A foreign OC-enriched session key that must NOT be purged.
        ocEnrichedSessionField: "keep-me",
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // agents table — personal agent so a per-user peer binding is made.
          return Object.assign(
            Promise.resolve([
              {
                id: "agent-1",
                name: "Smithers",
                model: "m",
                allowedTools: [],
                isPersonal: true,
                ownerId: "user-1",
              },
            ]),
            { innerJoin: mockInnerJoin([]), where: vi.fn().mockResolvedValue([]) }
          );
        }
        if (callCount === 5) {
          // channel_links table — a linked Telegram user exists.
          // Call order: 1 agents, 2 agentConnectionPermissions, 3 web-search
          // connections, 4 active MCP connections (native MCP), 5
          // channelLinks. The MCP query at slot 4 returns [] via the default
          // branch below, so allMcpPerms never runs and channelLinks lands at 5.
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

    // The stale identityLinks must be GONE — this is the upgrade fix.
    expect(config.session.identityLinks).toBeUndefined();
    // Everything else stays: dmScope, the reset override, AND the foreign key.
    expect(config.session.dmScope).toBe("per-peer");
    expect(config.session.reset).toEqual({ mode: "idle", idleMinutes: 525600 });
    expect(config.session.ocEnrichedSessionField).toBe("keep-me");
    // Per-user peer binding still routes the linked user's DMs to their agent.
    expect(config.bindings).toEqual(
      expect.arrayContaining([
        {
          agentId: "agent-1",
          match: {
            channel: "telegram",
            accountId: "agent-1",
            peer: { kind: "dm", id: "999888" },
          },
        },
      ])
    );
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
    // pinchy-files is now always emitted (workspace inject); document-extract is required bundled.
    expect(config.plugins.allow).toEqual([
      "pinchy-audit",
      "telegram",
      "pinchy-files",
      "pinchy-transcript",
      "document-extract",
    ]);
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

    mockedDb.select.mockReturnValue({
      from: mockFrom([]),
    } as never);
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-fake";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    // First generate with no existing file — with a WS client, config.apply is
    // used instead of a direct file write (Fix D: avoids the inotify race that
    // causes ConfigMutationConflictError on OC restarts, openclaw#75534).
    await regenerateOpenClawConfig();

    // Drain the first generate's background coroutine to let config.apply complete.
    await drainBackgroundCoroutine();
    const applyCallsBeforeSecondGenerate = mockConfigApply.mock.calls.length;
    // firstContent: payload sent to config.apply (file not written directly with WS client)
    const firstContent = mockConfigApply.mock.calls[0][0] as string;

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
      // pinchy-files is always emitted (workspace inject); document-extract is required bundled.
      expect(written.plugins.allow).toEqual([
        "pinchy-audit",
        "pinchy-context",
        "pinchy-docs",
        "telegram",
        "pinchy-files",
        "pinchy-transcript",
        "document-extract",
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

// NOTE (#508): the `describe("updateIdentityLinks", ...)` block was removed
// here together with the `updateIdentityLinks` helper it covered. We moved to
// a per-task session model and stopped emitting `session.identityLinks`, so
// the targeted-write helper has no remaining caller. The EACCES clobber-guard
// it exercised is still covered for the surviving targeted writers by the
// `updateTelegramChannelConfig` EACCES test below. Deletion authorized via the
// `Allow-test-deletion: #508` commit trailer.

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

    updateTelegramChannelConfig("agent-99", { botToken: "tg-secret-token" });

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.channels.telegram.accounts["agent-99"].botToken).toBe("tg-secret-token");
  });

  it("updateTelegramChannelConfig writes enabled: true so the targeted write matches the full regenerate shape (#193 channels-diff fix)", () => {
    // build.ts:regenerateOpenClawConfig emits `channels.telegram` with
    // `{enabled: true, dmPolicy, accounts}`. If the targeted write
    // from connectBot omits `enabled`, the next regenerate's add-`enabled`
    // shows up as a channels-block diff. OC 2026.5.12's BASE_RELOAD_RULES
    // doesn't list `channels`, so the default-deny classifies the diff
    // as restart-class — every agent CRUD after bot connect cascade-
    // restarts the gateway. Match the shape here so the diff is empty.
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan" },
      })
    );

    updateTelegramChannelConfig("agent-99", { botToken: "tg-secret-token" });

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.channels.telegram.enabled).toBe(true);
  });

  it("updateTelegramChannelConfig PURGES a stale session.identityLinks on the targeted write path (#508 upgrade path)", () => {
    // The targeted write (bot connect/disconnect, no full regenerate) spreads
    // the on-disk `session` block independently of build.ts. On a prod/demo
    // install that already has a stale `session.identityLinks` baked in from a
    // pre-per-task version, a bot connect/disconnect would otherwise preserve
    // it forever → OpenClaw keeps unifying Telegram with the web session. The
    // targeted writer must ALSO purge it unconditionally. Only identityLinks
    // is purged; other session fields are preserved.
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan" },
        session: {
          identityLinks: { "user-1": ["telegram:999"] },
          reset: { mode: "idle", idleMinutes: 525600 },
          ocEnrichedSessionField: "keep-me",
        },
      })
    );

    updateTelegramChannelConfig("agent-99", { botToken: "tg-secret-token" });

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    // Stale identityLinks gone.
    expect(config.session.identityLinks).toBeUndefined();
    // dmScope set, other session fields preserved.
    expect(config.session.dmScope).toBe("per-peer");
    expect(config.session.reset).toEqual({ mode: "idle", idleMinutes: 525600 });
    expect(config.session.ocEnrichedSessionField).toBe("keep-me");
  });

  it("updateTelegramChannelConfig throws if existing config is unreadable (avoids clobber from EACCES, #314)", () => {
    // Parallel to the updateIdentityLinks EACCES regression test. The
    // original telegram-e2e cascade hit this exact path: bot connect →
    // updateTelegramChannelConfig → readExistingConfig EACCES → previously
    // returned {} → channels/bindings written without gateway → OC refuses
    // to start. Two layers of defence apply (same as updateIdentityLinks):
    //   1. readExistingConfig propagates persistent EACCES (#314).
    //   2. updateTelegramChannelConfig independently guards on missing
    //      gateway.mode (covers ENOENT / parse-error empty objects).
    // Throwing surfaces a 5xx so the bot-connect API route lets the user
    // retry rather than silently dropping the channel update.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as Error & { code: string };
      err.code = "EACCES";
      throw err;
    });

    expect(() => updateTelegramChannelConfig("agent-99", { botToken: "tg-secret-token" })).toThrow(
      /EACCES|gateway\.mode/
    );
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("regenerateOpenClawConfig validation guard", () => {
  beforeEach(() => {
    mockValidateBuiltConfig.mockReturnValue({ ok: true });
    mockedReadFileSync.mockReturnValue("");
  });

  it("throws when validateBuiltConfig reports an invalid plugin config", async () => {
    mockValidateBuiltConfig.mockReturnValueOnce({
      ok: false,
      errors: ["pinchy-odoo: agents: injected test error"],
    });
    await expect(regenerateOpenClawConfig()).rejects.toThrow(
      /Refusing to write invalid plugin config/
    );
  });
});

describe("regenerateOpenClawConfig size-drop guard (#311)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetOrCreateGatewayToken.mockResolvedValue("test-gateway-token");
    mockedExistsSync.mockReturnValue(true);
    mockReadSecretsFile.mockReturnValue({});
    mockValidateBuiltConfig.mockReturnValue({ ok: true });
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });
    _resetPushGeneration();
  });

  it("refuses to write a config that would shrink the file by more than 50%", async () => {
    // Simulates the #311 cascade fingerprint: OpenClaw has a healthy config
    // on disk (gateway + agents + channels.telegram + bindings + session),
    // but a regenerate runs through a window where DB-derived telegram
    // state isn't reachable (race observed in the agent-create-no-restart
    // flake) and would produce a tiny payload. Without this guard, Pinchy
    // would writeConfigAtomic the tiny payload — OpenClaw's inotify watcher
    // diffs it against the in-memory baseline, sees channels/bindings/
    // session vanish, classifies the diff as restart-required, triggers a
    // full gateway restart cascade, and the apply RPC is rejected with
    // size-drop:OLD->NEW. We mirror OpenClaw's own 50% threshold here so
    // the bad payload never reaches disk in the first place.
    //
    // Padding lives under `secrets` — a top-level OC-managed field that's
    // neither read into the regenerated payload (build.ts) nor supplemented
    // into it (normalize.ts:supplementFromSource). That keeps the size
    // delta between existing (with padding) and new (without) representative
    // of the real failure: existing has substantial OC-managed state, new
    // is a pure Pinchy regenerate.
    const padding = "x".repeat(8000);
    const largeExisting =
      JSON.stringify(
        {
          gateway: {
            mode: "local",
            bind: "lan",
            auth: { mode: "token", token: "test-gateway-token" },
            controlUi: { enabled: false },
          },
          secrets: { padding }, // ~8kB of OC-side state that Pinchy doesn't reproduce
          agents: {
            list: [
              {
                id: "smithers",
                name: "Smithers",
                model: "anthropic/claude-haiku-4-5-20251001",
              },
            ],
          },
          plugins: { allow: ["pinchy-files"], entries: {} },
          channels: {
            telegram: {
              enabled: true,
              dmPolicy: "pairing",
              accounts: { smithers: { botToken: "123:ABC" } },
            },
          },
          bindings: [
            { agentId: "smithers", match: { channel: "telegram", accountId: "smithers" } },
          ],
          session: { dmScope: "per-peer" },
          meta: { lastTouchedAt: 1700000000 },
        },
        null,
        2
      ).trimEnd() + "\n";
    expect(largeExisting.length).toBeGreaterThan(8000); // sanity
    mockedReadFileSync.mockReturnValue(largeExisting);

    // No agents and no telegram tokens in DB — the regenerate produces a
    // payload missing the entire agents list, channels.telegram block, and
    // bindings. That's substantially smaller than `largeExisting`.
    mockedDb.select.mockReturnValue({ from: mockFrom([]) } as never);
    mockedGetSetting.mockResolvedValue(null);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await regenerateOpenClawConfig();
    } finally {
      // (capture any error logs first; restore at end)
    }

    // openclaw.json must NOT have been written — preserving OpenClaw's
    // healthy config is the whole point of this guard. Filter on the
    // canonical .tmp suffix that writeConfigAtomic uses so we don't
    // accidentally count the postmortem `.regenerate-rejected.<ts>` dump
    // (which legitimately writes the rejected payload for debugging).
    const canonicalWrites = mockedWriteFileSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).endsWith("openclaw.json.tmp")
    );
    expect(
      canonicalWrites,
      `expected 0 canonical openclaw.json writes, got ${canonicalWrites.length}: ` +
        canonicalWrites.map((c) => `len=${(c[1] as string).length}`).join(", ")
    ).toHaveLength(0);

    // The postmortem dump SHOULD be written so the underlying race is
    // debuggable from disk after the fact.
    const postmortemWrites = mockedWriteFileSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes(".regenerate-rejected.")
    );
    expect(postmortemWrites).toHaveLength(1);

    // The guard must log loudly so the underlying race is observable in
    // production — silent skip would hide the bug forever.
    const errorMessages = errorSpy.mock.calls.flat().join(" ");
    expect(errorMessages).toMatch(/size-drop|refus|shrink|small/i);

    errorSpy.mockRestore();
  });

  it("does NOT trigger when new content is at the threshold (>= 50%) of existing", async () => {
    // Boundary check: legitimate moderate reductions must pass through.
    // Constructing a payload that's exactly between 50% and 100% of the
    // existing file is brittle, so instead we exercise the threshold
    // arithmetic directly and confirm the guard does not fire.
    //
    // Mock readFileSync to return content exactly 1.99x the new payload
    // size (just below the 2x threshold). The guard's predicate
    //   `newContent.length < existing.length * 0.5`
    // must evaluate to false in this case — proving the threshold is
    // strict-less-than, not less-than-or-equal.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Use a stable, predictable payload by mocking the new content path
    // through the existing-equality check. We construct an existing that
    // is *larger* than the new content but not by 2x. The new content
    // emerges from the empty-DB regenerate (~881 bytes in this fixture);
    // we need existing < 1762 bytes to keep the ratio above 0.5.
    const justUnderTwoX =
      JSON.stringify(
        {
          gateway: {
            mode: "local",
            bind: "lan",
            auth: { mode: "token", token: "test-gateway-token" },
            controlUi: { enabled: false },
          },
          secrets: { padding: "x".repeat(700) },
          agents: { list: [] },
          plugins: { allow: ["pinchy-files"], entries: {} },
        },
        null,
        2
      ).trimEnd() + "\n";
    expect(justUnderTwoX.length).toBeGreaterThan(900); // > new content
    expect(justUnderTwoX.length).toBeLessThan(1800); // < 2x new content
    mockedReadFileSync.mockReturnValue(justUnderTwoX);

    mockedDb.select.mockReturnValue({ from: mockFrom([]) } as never);
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    // Guard must NOT have logged — this is the no-false-positive proof.
    const errorMessages = errorSpy.mock.calls.flat().join(" ");
    expect(errorMessages).not.toMatch(/size-drop|suspiciously small/i);

    // No `.regenerate-rejected.` postmortem dump must have been written.
    const postmortemWrites = mockedWriteFileSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes(".regenerate-rejected.")
    );
    expect(postmortemWrites).toHaveLength(0);

    errorSpy.mockRestore();
  });

  it("auto-sets agents.defaults.pdfModel when Anthropic is configured (preferred native PDF provider)", async () => {
    // Anthropic has a configured API key → should be preferred for native PDF
    mockedGetSetting.mockImplementation(async (key: string) =>
      key === "anthropic_api_key" ? "sk-ant-test" : null
    );
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents.defaults.pdfModel).toEqual({
      primary: "anthropic/claude-haiku-4-5-20251001",
    });
  });

  it("falls back to a vision-capable non-native model when Anthropic/Google are not configured", async () => {
    // Only ollama-cloud configured; gemini-3-flash-preview is vision-capable
    mockedGetSetting.mockImplementation(async (key: string) =>
      key === "ollama_cloud_api_key" ? "test-key" : null
    );
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents.defaults.pdfModel).toBeDefined();
    expect(config.agents.defaults.pdfModel.primary).toBe("ollama-cloud/gemini-3-flash-preview");
  });

  it("does not set agents.defaults.pdfModel when no provider is configured", async () => {
    // Default: getSetting always returns null
    mockedGetSetting.mockResolvedValue(null);
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents?.defaults?.pdfModel).toBeUndefined();
  });

  // Originally `resolveDefaultPdfModel` iterated `Object.entries(PROVIDERS)`
  // and returned the first vision-capable non-native model found, which means
  // the preference was implicit (JS insertion order in PROVIDERS) and would
  // silently shift if a new provider were inserted higher in the object.
  // These tests pin the order EXPLICITLY: native PDF (anthropic > google)
  // wins over vision fallback (openai > ollama-cloud > ollama-local). Any
  // future provider must be wired into the explicit list in build.ts to
  // appear at all.
  it("prefers openai over ollama-cloud in the vision-capable fallback (explicit order)", async () => {
    // Both non-native vision providers configured. Without explicit ordering
    // this test passes only by coincidence of PROVIDERS insertion order.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "openai_api_key") return "sk-openai-test";
      if (key === "ollama_cloud_api_key") return "ollama-test";
      return null;
    });
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents.defaults.pdfModel.primary).toBe("openai/gpt-5.4-mini");
  });

  it("prefers anthropic over google when both native PDF providers are configured", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test";
      if (key === "google_api_key") return "AIza-test";
      return null;
    });
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents.defaults.pdfModel.primary).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("native PDF providers (anthropic, google) win over vision fallback (openai, ollama-cloud)", async () => {
    // Native PDF mode sends raw bytes — higher fidelity than the
    // image-extract fallback. Order: anthropic/google > openai/ollama-cloud.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "google_api_key") return "AIza-test";
      if (key === "openai_api_key") return "sk-openai-test";
      return null;
    });
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents.defaults.pdfModel.primary).toBe("google/gemini-2.5-flash");
  });
});

// `agents.defaults.imageModel.primary` mirrors `pdfModel` but for the
// built-in `image` tool. Without it, OpenClaw scans providers in their
// declared order and picks the first vision-flagged model — which on an
// ollama-cloud-only stack used to land on `devstral-small-2:24b`
// alphabetically, even though the live API rejects images for that model
// with HTTP 400 (#416). Pinning the choice via `imageModel.primary`
// removes that fragility.
//
// These tests rely on the same mock shape as the size-drop guard block
// above — minimal `existsSync`/secrets/validation stubs plus `getSetting`
// indirection — so the `beforeEach` is duplicated verbatim. Kept in a
// separate `describe` so a future bisect on #311 isn't misled by hits in
// imageModel tests, and vice versa.
describe("regenerateOpenClawConfig imageModel.primary (#416)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetOrCreateGatewayToken.mockResolvedValue("test-gateway-token");
    mockedExistsSync.mockReturnValue(true);
    mockReadSecretsFile.mockReturnValue({});
    mockValidateBuiltConfig.mockReturnValue({ ok: true });
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });
    _resetPushGeneration();
  });

  it("auto-sets agents.defaults.imageModel.primary when Anthropic is configured", async () => {
    mockedGetSetting.mockImplementation(async (key: string) =>
      key === "anthropic_api_key" ? "sk-ant-test" : null
    );
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents.defaults.imageModel).toEqual({
      primary: "anthropic/claude-haiku-4-5-20251001",
    });
  });

  it("does not set agents.defaults.imageModel when no provider is configured", async () => {
    mockedGetSetting.mockResolvedValue(null);
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents?.defaults?.imageModel).toBeUndefined();
  });

  it("prefers anthropic over google when both native vision providers are configured (image)", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test";
      if (key === "google_api_key") return "AIza-test";
      return null;
    });
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents.defaults.imageModel.primary).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("prefers openai over ollama-cloud in the vision-capable fallback (image)", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "openai_api_key") return "sk-openai-test";
      if (key === "ollama_cloud_api_key") return "ollama-test";
      return null;
    });
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents.defaults.imageModel.primary).toBe("openai/gpt-5.4-mini");
  });

  it("picks the canonical-vision ollama-cloud model when only ollama-cloud is configured", async () => {
    // The provider's general balanced default is `glm-4.7` (text-only) and
    // several other ollama-cloud models are weaker on images: mistral-large-3
    // and kimi-k2.5/k2.6 accept image input but occasionally misread digits,
    // and qwen3.5:397b only claims vision (it hallucinates image contents and
    // is flagged text-only). The image-default picker explicitly prefers the
    // best empirically vision-verified models — gemini-3-flash > minimax-m3 >
    // gemma4 (qwen3-vl led this list until Ollama dropped it upstream) — over
    // those weaker models.
    mockedGetSetting.mockImplementation(async (key: string) =>
      key === "ollama_cloud_api_key" ? "test-key" : null
    );
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents.defaults.imageModel.primary).toBe("ollama-cloud/gemini-3-flash-preview");
  });

  it("native vision providers (anthropic, google) beat ollama-cloud for imageModel", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "google_api_key") return "AIza-test";
      if (key === "ollama_cloud_api_key") return "ollama-test";
      return null;
    });
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents.defaults.imageModel.primary).toBe("google/gemini-2.5-flash");
  });

  it("skips a preferred ollama-cloud image model that is no longer in the live catalog", async () => {
    // The v0.5.8 incident: `gemini-3-flash-preview` would normally win, but if
    // Ollama retires it upstream it drops out of /v1/models. The resolver must
    // NOT pin the dead model — it falls through to the next LIVE preference.
    mockedGetSetting.mockImplementation(async (key: string) =>
      key === "ollama_cloud_api_key" ? "test-key" : null
    );
    mockedFetchProviderModels.mockResolvedValueOnce([
      {
        id: "ollama-cloud",
        name: "Ollama Cloud",
        // gemini-3-flash-preview retired upstream → absent here.
        models: [
          { id: "ollama-cloud/minimax-m3", name: "minimax-m3" },
          { id: "ollama-cloud/gemma4:31b", name: "gemma4:31b" },
        ],
      },
    ]);
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents.defaults.imageModel.primary).toBe("ollama-cloud/minimax-m3");
  });

  it("emits no imageModel when no preferred ollama-cloud model is live", async () => {
    // Every vision-verified preference has been retired upstream. Better to
    // emit no imageModel (built-in image tool simply doesn't register) than to
    // pin a dead model that 410s on every call.
    mockedGetSetting.mockImplementation(async (key: string) =>
      key === "ollama_cloud_api_key" ? "test-key" : null
    );
    mockedFetchProviderModels.mockResolvedValueOnce([
      { id: "ollama-cloud", name: "Ollama Cloud", models: [] },
    ]);
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents?.defaults?.imageModel).toBeUndefined();
  });

  it("emits no imageModel when the live catalog has no ollama-cloud provider at all", async () => {
    // Defensive: if /v1/models fetch yields no ollama-cloud entry (and the
    // FALLBACK didn't kick in), the live id set is empty → no pick, no pin.
    mockedGetSetting.mockImplementation(async (key: string) =>
      key === "ollama_cloud_api_key" ? "test-key" : null
    );
    mockedFetchProviderModels.mockResolvedValueOnce([]);
    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.agents?.defaults?.imageModel).toBeUndefined();
  });
});
