/**
 * Deleting a large provider must reach OpenClaw through OpenClaw's OWN config
 * writer — the same `writeConfigFile` that `config.apply` commits through —
 * not through a fake that encodes our reading of its rules.
 *
 * OpenClaw 2026.7.1 refuses a config write that is under half of the file it
 * replaces (`size-drop:OLD->NEW`; baseline = the current openclaw.json, >= 512
 * bytes; `resolveConfigWriteSuspiciousReasons` / `resolveConfigWriteBlockingReasons`
 * in its config io). The gateway RPCs (config.apply, config.patch, config.set)
 * never pass `allowConfigSizeDrop`, so there is no request that lifts it. This
 * test drives `pushConfigInBackground` against a client whose `config.apply`
 * IS that writer, and proves two things:
 *
 *   1. the one-shot apply of the shrunken config is refused (the bug), and
 *   2. the stepwise push lands it — every step accepted by the real size-drop
 *      check AND the real schema validation (a deleted provider's stub must
 *      still be a valid custom provider: baseUrl + models are mandatory).
 *
 * It also proves Pinchy never wrote openclaw.json itself: Pinchy's CONFIG_PATH
 * points at a separate file that must never come into existence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mockGetClient = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

type Json = Record<string, unknown>;

function model(i: number): Json {
  return {
    id: `acme-model-${i}-with-a-realistically-long-identifier`,
    name: `Acme Model ${i} (realistic display name)`,
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.5 },
  };
}

function config(extraProviders: Json = {}): Json {
  return {
    gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token: "t".repeat(40) } },
    agents: { list: [{ id: "smithers", name: "Smithers" }] },
    models: {
      providers: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          models: [{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" }],
        },
        ...extraProviders,
      },
    },
  };
}

const acme = {
  baseUrl: "https://acme.example/v1",
  api: "openai-completions",
  models: Array.from({ length: 40 }, (_, i) => model(i)),
};

describe("a >50% provider deletion against OpenClaw's real config writer", () => {
  let dir: string;
  let ocConfigPath: string;
  let pinchyConfigPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-size-drop-"));
    ocConfigPath = join(dir, "openclaw.json");
    pinchyConfigPath = join(dir, "pinchy-must-not-write.json");
    process.env.OPENCLAW_STATE_DIR = dir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is refused in one shot and lands in steps, each accepted by OpenClaw", async () => {
    // Pinchy's module captures CONFIG_PATH at import; OpenClaw resolves the env
    // on every call. Import Pinchy against a path nothing may write, then point
    // OpenClaw at the real file.
    process.env.OPENCLAW_CONFIG_PATH = pinchyConfigPath;
    const { pushConfigInBackground } = await import("@/lib/openclaw-config/write");
    const { getPendingConfigPushCount } = await import("@/lib/openclaw-config/push-state");
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    const { writeConfigFile, readConfigFileSnapshotForWrite } =
      await import("openclaw/plugin-sdk/config-runtime");
    type OcConfig = Parameters<typeof writeConfigFile>[0];

    await writeConfigFile(config({ "acme-llm": acme }) as OcConfig);
    const target = JSON.stringify(config(), null, 2);

    // (1) The bug: OpenClaw's writer refuses the deletion as a single write.
    await expect(writeConfigFile(JSON.parse(target) as OcConfig)).rejects.toThrow(
      /size-drop:\d+->\d+/
    );

    // config.get answers from OpenClaw's own snapshot, as the gateway does:
    // `config` is the MATERIALIZED runtime view (every model gains defaults
    // such as a per-model `api`), `parsed` is the file as authored.
    const accepted: string[] = [];
    mockGetClient.mockReturnValue({
      config: {
        get: async () => {
          const { snapshot } = await readConfigFileSnapshotForWrite();
          return { hash: snapshot.hash, config: snapshot.config, parsed: snapshot.parsed };
        },
        apply: async (raw: string) => {
          await writeConfigFile(JSON.parse(raw) as OcConfig);
          accepted.push(readFileSync(ocConfigPath, "utf-8"));
        },
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onChangeApplied = vi.fn();

    pushConfigInBackground(target, { onChangeApplied });
    for (let i = 0; i < 2000 && getPendingConfigPushCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // (2) The fix: it landed, in more than one accepted write.
    expect(getPendingConfigPushCount()).toBe(0);
    expect(errorSpy.mock.calls.flat().join(" ")).toBe("");
    expect(onChangeApplied).toHaveBeenCalledTimes(1);
    const final = JSON.parse(readFileSync(ocConfigPath, "utf-8")) as {
      models: { providers: Json };
    };
    expect(final.models.providers).not.toHaveProperty("acme-llm");
    expect(final.models.providers).toHaveProperty("anthropic");
    expect(accepted.length).toBeGreaterThan(1);
    // Steps re-add the provider as authored, never OpenClaw's materialized view.
    for (const file of accepted) {
      const acmeModels =
        (JSON.parse(file) as { models: { providers: Record<string, { models: Json[] }> } }).models
          .providers["acme-llm"]?.models ?? [];
      expect(acmeModels.every((m) => !("api" in m))).toBe(true);
    }
    expect(existsSync(pinchyConfigPath), "Pinchy must not write openclaw.json itself").toBe(false);
  }, 60_000);
});
