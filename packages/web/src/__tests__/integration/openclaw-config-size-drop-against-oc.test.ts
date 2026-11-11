/**
 * Deleting a large provider must reach OpenClaw through OpenClaw's OWN gateway
 * handlers — the real `config.get` and `config.apply` — not through a fake that
 * encodes our reading of its rules.
 *
 * OpenClaw 2026.7.1 refuses a config write that is under half of the file it
 * replaces (`size-drop:OLD->NEW`; baseline = the current openclaw.json, >= 512
 * bytes; `resolveConfigWriteSuspiciousReasons` / `resolveConfigWriteBlockingReasons`
 * in its config io). The gateway RPCs (config.apply, config.patch, config.set)
 * never pass `allowConfigSizeDrop`, so there is no request that lifts it.
 *
 * This drives `pushConfigInBackground` against a client whose `get` and `apply`
 * ARE the gateway's `configHandlers`, so every step goes through what a live
 * gateway does to a request and nothing is skipped:
 *
 *   - `config.get` answers with `redactConfigSnapshot` applied — credentials,
 *     SecretRef ids and credential-bearing URLs come back as
 *     `__OPENCLAW_REDACTED__`;
 *   - `config.apply` runs `restoreRedactedValues` against the file, validates
 *     the source AND the materialized config, resolves every SecretRef against
 *     the secrets file (`prepareSecretsRuntimeSnapshot`), and commits through
 *     the size-drop-checking writer.
 *
 * It proves:
 *
 *   1. the one-shot apply of the shrunken config is refused (the bug);
 *   2. the stepwise push lands it, every step accepted by all of the above —
 *      including SecretRef resolution after secrets.json lost the deleted
 *      provider's key;
 *   3. no step re-writes the deleted provider's credentials into openclaw.json.
 *      `restoreRedactedValues` puts back whatever `config.get` redacted at the
 *      same path, so a stub that echoed the redacted baseUrl would have
 *      OpenClaw restore `user:pass@…?api-key=…` into every intermediate file
 *      (verified: it does). The stub carries an inert baseUrl instead.
 *
 * And that Pinchy never wrote openclaw.json itself: Pinchy's CONFIG_PATH points
 * at a separate file that must never come into existence.
 *
 * The same handlers, plus OpenClaw's startup read and startup SecretRef
 * activation, judge the file Pinchy leaves on disk while a deletion is pending
 * (keyless-bridge.ts): with the deleted key already gone from secrets.json,
 * OpenClaw must still start on it and accept a targeted writer's copy of it —
 * and so must an install that lost the key before this fix.
 *
 * The handlers are not part of OpenClaw's public exports, so the test finds the
 * chunk that exports `configHandlers` in the pinned package's `dist/`. An
 * OpenClaw bump that renames or splits it fails here loudly, never silently.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { endPinchyProcess } from "@/test-helpers/pinchy-restart";
import {
  gatewayRequest,
  importDefined,
  loadGatewayHandlers,
  openClawDist,
  releaseGatewayWrites,
  type GatewayHandler,
} from "@/test-helpers/openclaw-gateway-handlers";

const mockGetClient = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

// In production Pinchy cannot read secrets.json: start-openclaw.sh's 50 ms
// fix-config-permissions tick chowns it to root:root 0600, and Pinchy runs as
// uid 999. Nothing here may depend on reading it, so here Pinchy cannot read
// it either: `fs.readFileSync` of the current test's secrets.json throws
// EACCES. That is the one call every Pinchy read of the file goes through —
// `readSecretsFile`, and `writeSecretsFile`'s read of the previous file (for
// its reload flag and the identical-write skip) — and both run unmocked on top
// of it. Pinchy reads the file through no other fs API today; one that did
// would escape this seam.
//
// OpenClaw reads the same file, as root does in production, and must succeed:
// its dist/ is loaded by Node itself (vitest externalizes node_modules), so
// this mock never reaches it — every `startOpenClaw()` below that resolves a
// SecretRef proves that. The test reads the file the same way, through
// `readAsOpenClaw`.
const unreadableToPinchy = vi.hoisted(() => ({
  path: "",
  readAsOpenClaw: (_path: string): string => {
    throw new Error("fs mock not loaded");
  },
}));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  unreadableToPinchy.readAsOpenClaw = (path) => actual.readFileSync(path, "utf-8");
  const readFileSync = ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
    if (unreadableToPinchy.path !== "" && String(path) === unreadableToPinchy.path) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), {
        code: "EACCES",
      });
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

type Json = Record<string, unknown>;

/**
 * The options a test's setup writes its starting openclaw.json with. OpenClaw
 * 2026.9 reads a missing file as one holding the implicit "main" agent and
 * refuses a write that drops it; a setup file stands for an install that has
 * long since replaced it, which is how OpenClaw's own first-agent bootstrap
 * writes it (`allowedAgentRosterRemovals: ["main"]`).
 */
const SEED = { allowedAgentRosterRemovals: ["main"] };

type ConfigHandler = GatewayHandler;
const loadConfigHandlers = loadGatewayHandlers;
const request = gatewayRequest;

/** openclaw-node's `client.request`, answered by the real handlers (Pinchy calls agents.delete). */
const agentsRequest = (handlers: Record<string, ConfigHandler>) => (method: string, params: Json) =>
  request(handlers[method], params);

/**
 * config.apply as Pinchy's client sees it — except that a write OpenClaw
 * committed while a SecretRef in it resolves to nothing rejects here. Up to
 * 2026.7 OpenClaw refused such a write outright (a SecretRef error); 2026.9
 * commits it and names the owner in `degradedSecretOwners`, and every call
 * through that provider then fails. Either way the write left OpenClaw on a
 * config it cannot run as meant — what these tests guard against.
 */
async function strictApply(handler: ConfigHandler, params: Json): Promise<Json> {
  const response = await request(handler, params);
  const degraded = response.degradedSecretOwners;
  if (Array.isArray(degraded) && degraded.length > 0) {
    throw new Error(
      `config.apply committed with SecretRef owners unavailable: ${JSON.stringify(degraded)}`
    );
  }
  return response;
}

interface OcSnapshot {
  valid: boolean;
  config: Json;
}

/** dist/config/config.js — the module OpenClaw's own gateway start imports its config reads from. */
async function loadOcConfigModule() {
  return (await import(pathToFileURL(join(openClawDist(), "config", "config.js")).href)) as {
    readConfigFileSnapshot: () => Promise<OcSnapshot>;
    readConfigFileSnapshotWithPluginMetadata: (options: Json) => Promise<{ snapshot: OcSnapshot }>;
    promoteConfigSnapshotToLastKnownGood: (snapshot: OcSnapshot) => Promise<unknown>;
  };
}

/** What the gateway's config reloader does with every config it accepts. */
async function promoteToLastKnownGood(): Promise<void> {
  const oc = await loadOcConfigModule();
  await oc.promoteConfigSnapshotToLastKnownGood(await oc.readConfigFileSnapshot());
}

/**
 * What OpenClaw does with openclaw.json when it (re)starts, minus the network:
 * the startup read (`readGatewayStartupConfig`: recoverSuspicious, which
 * restores last-known-good / `.bak` over a file under half of it) and the
 * startup SecretRef activation (`createRuntimeSecretsActivator`, reason
 * "startup"). Resolves with the config it would run.
 *
 * Up to 2026.7 that activation threw "Startup failed: required secrets are
 * unavailable" on a SecretRef the secrets file cannot resolve: a crash loop.
 * 2026.9 starts anyway and marks the owner "configured-unavailable"
 * ([SECRETS_OWNER_UNAVAILABLE]) — for a provider, every call through it then
 * fails. Either way OpenClaw does not run the config Pinchy meant, so a
 * degraded start rejects here too, worded so the same assertions match both.
 */
async function startOpenClaw(): Promise<Json> {
  const oc = await loadOcConfigModule();
  const { snapshot } = await oc.readConfigFileSnapshotWithPluginMetadata({
    isolateEnv: true,
    recoverSuspicious: true,
  });
  expect(snapshot.valid, "OpenClaw's startup read must find a valid config").toBe(true);
  type Activate = (config: Json, params: { reason: string; activate: boolean }) => Promise<unknown>;
  const createRuntimeSecretsActivator = await importDefined<(params: Json) => Activate>(
    "createRuntimeSecretsActivator"
  );
  const silent = { info: () => {}, warn: () => {}, error: () => {} };
  const activate = createRuntimeSecretsActivator({ logSecrets: silent, emitStateEvent: () => {} });
  const prepared = (await activate(snapshot.config, { reason: "startup", activate: false })) as {
    degradedOwners?: { ownerKind: string; ownerId: string; reason?: string }[];
  };
  const degraded = prepared?.degradedOwners ?? [];
  if (degraded.length > 0) {
    const owners = degraded.map((o) => `${o.ownerKind}:${o.ownerId} (${o.reason})`).join(", ");
    throw new Error(`Startup degraded: required secrets are unavailable for ${owners}`);
  }
  return snapshot.config;
}

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

const ref = (id: string) => ({ source: "file", provider: "pinchy", id });

// A deleted provider whose URL carries credentials in both places OpenClaw's
// redaction knows: userinfo and an auth-like query parameter.
const ACME_URL_USER_SECRET = "acme-user-s3cret";
const ACME_URL_QUERY_SECRET = "acme-query-QQQ";

describe("a >50% provider deletion against OpenClaw's real config.get / config.apply", () => {
  let dir: string;
  let ocConfigPath: string;
  let pinchyConfigPath: string;
  let secretsPath: string;

  function config(extraProviders: Json = {}): Json {
    return {
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token: "t".repeat(40) } },
      secrets: { providers: { pinchy: { source: "file", path: secretsPath, mode: "json" } } },
      agents: { entries: { smithers: { name: "Smithers" } } },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            api: "anthropic-messages",
            apiKey: ref("/providers/anthropic/apiKey"),
            models: [{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" }],
          },
          ...extraProviders,
        },
      },
    };
  }

  const acme = () => ({
    baseUrl: `https://admin:${ACME_URL_USER_SECRET}@acme.example/v1?api-key=${ACME_URL_QUERY_SECRET}`,
    api: "openai-completions",
    apiKey: ref("/providers/acme-llm/apiKey"),
    models: Array.from({ length: 40 }, (_, i) => model(i)),
  });

  function writeSecrets(providers: Record<string, { apiKey: string }>) {
    // OpenClaw refuses a secrets file readable by others (insecure-permissions).
    writeFileSync(secretsPath, JSON.stringify({ providers }), { mode: 0o600 });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-size-drop-"));
    ocConfigPath = join(dir, "openclaw.json");
    pinchyConfigPath = join(dir, "pinchy-must-not-write.json");
    secretsPath = join(dir, "secrets.json");
    unreadableToPinchy.path = secretsPath;
    process.env.OPENCLAW_STATE_DIR = dir;
    vi.resetModules();
  });

  afterEach(() => {
    releaseGatewayWrites();
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    unreadableToPinchy.path = "";
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is refused in one shot and lands in steps, each accepted by the real handlers, without re-writing the deleted provider's credentials", async () => {
    // Pinchy's module captures CONFIG_PATH at import; OpenClaw resolves the env
    // on every call. Import Pinchy against a path nothing may write, then point
    // OpenClaw at the real file.
    process.env.OPENCLAW_CONFIG_PATH = pinchyConfigPath;
    const { pushConfigInBackground } = await import("@/lib/openclaw-config/write");
    const { getPendingConfigPushCount } = await import("@/lib/openclaw-config/push-state");
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    const { writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
    type OcConfig = Parameters<typeof writeConfigFile>[0];
    const handlers = await loadConfigHandlers();
    const get = () => request(handlers["config.get"], {});
    const apply = (raw: string, baseHash?: string, options: Json = {}) =>
      strictApply(handlers["config.apply"], { raw, ...(baseHash ? { baseHash } : {}), ...options });

    writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, "acme-llm": { apiKey: "sk-acme" } });
    await writeConfigFile(config({ "acme-llm": acme() }) as OcConfig, SEED);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // What config.get hands Pinchy is redacted — the premise of (3).
    const snapshot = await get();
    const ocAcme = (snapshot.parsed as { models: { providers: Record<string, Json> } }).models
      .providers["acme-llm"];
    expect(ocAcme.baseUrl).toBe("__OPENCLAW_REDACTED__");

    // Regenerate removed the provider's key from secrets.json before pushing.
    writeSecrets({ anthropic: { apiKey: "sk-ant-test" } });
    const target = JSON.stringify(config(), null, 2);

    // (1) The bug: the real config.apply refuses the deletion as a single write.
    await expect(apply(target, snapshot.hash as string)).rejects.toThrow(/size-drop:\d+->\d+/);

    const accepted: string[] = [];
    mockGetClient.mockReturnValue({
      config: {
        get,
        apply: async (raw: string, baseHash?: string, options?: Json) => {
          await apply(raw, baseHash, options);
          accepted.push(readFileSync(ocConfigPath, "utf-8"));
        },
      },
    });
    const onChangeApplied = vi.fn();

    pushConfigInBackground(target, { onChangeApplied, fullRegenerate: true });
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
    const steps = accepted.slice(0, -1);
    expect(steps.length).toBeGreaterThan(0);
    for (const file of steps) {
      const stub = (JSON.parse(file) as { models: { providers: Record<string, Json> } }).models
        .providers["acme-llm"];
      expect(stub, "every step carries the deleted provider as a stub").toBeDefined();
      // (3) restoreRedactedValues must have had nothing to restore into it.
      expect(stub).not.toHaveProperty("apiKey");
      expect(file).not.toContain(ACME_URL_USER_SECRET);
      expect(file).not.toContain(ACME_URL_QUERY_SECRET);
      // Steps re-add the provider as authored, never OpenClaw's materialized
      // view (which gives every model a per-model `api`).
      expect((stub.models as Json[]).every((m) => !("api" in m))).toBe(true);
    }
    expect(existsSync(pinchyConfigPath), "Pinchy must not write openclaw.json itself").toBe(false);
  }, 60_000);

  // regenerateOpenClawConfig writes secrets.json from the database, so the
  // deleted provider's key is gone from it before the push even starts — and
  // the hand-over above takes minutes in production, or is dropped and resumed.
  // For that window OpenClaw's openclaw.json is read by OpenClaw itself on a
  // restart, and copied by every targeted writer (updateTelegramChannelConfig
  // reads it, changes one block and applies it). Pinchy therefore first writes
  // the on-disk file with the deleted provider as a key-less stub that keeps
  // its models (keyless-bridge.ts). Pinchy reads secrets.json for none of this
  // — in production it cannot (root:root 0600), and here it cannot either
  // (the fs mock at the top).
  it("leaves OpenClaw a file it can restart on and apply while a deletion is handed over", async () => {
    process.env.OPENCLAW_CONFIG_PATH = pinchyConfigPath;
    process.env.OPENCLAW_SECRETS_PATH = secretsPath;
    const { pushConfigInBackground } = await import("@/lib/openclaw-config/write");
    const { getPendingConfigPushCount } = await import("@/lib/openclaw-config/push-state");
    const { keylessBridge } = await import("@/lib/openclaw-config/keyless-bridge");
    const { writeSecretsFile, readSecretsFile } = await import("@/lib/openclaw-secrets");
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    const { writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
    type OcConfig = Parameters<typeof writeConfigFile>[0];
    const handlers = await loadConfigHandlers();
    const get = () => request(handlers["config.get"], {});
    const apply = (raw: string, baseHash?: string, options: Json = {}) =>
      strictApply(handlers["config.apply"], { raw, ...(baseHash ? { baseHash } : {}), ...options });
    try {
      writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, "acme-llm": { apiKey: "sk-acme" } });
      expect(() => readSecretsFile(), "precondition: Pinchy cannot read secrets.json").toThrow(
        /EACCES/
      );
      await writeConfigFile(config({ "acme-llm": acme() }) as OcConfig, SEED);
      await promoteToLastKnownGood();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const target = config();
      // What regenerate builds after the deletion: the key is not in it.
      const authoritative = { providers: { anthropic: { apiKey: "sk-ant-test" } } };
      // A targeted write: the on-disk file with one block changed.
      const targeted = () => {
        const onDisk = JSON.parse(readFileSync(ocConfigPath, "utf-8")) as Json;
        delete onDisk.meta;
        return JSON.stringify(
          {
            ...onDisk,
            agents: {
              ownership: "explicit",
              entries: { smithers: { name: "Smithers" }, kb: { name: "KB" } },
            },
          },
          null,
          2
        );
      };

      // The bug: secrets.json without the key next to a file that still names
      // it. OpenClaw cannot start on that file, and refuses a copy of it.
      writeSecretsFile(authoritative);
      await expect(startOpenClaw()).rejects.toThrow(/required secrets are unavailable/);
      await expect(apply(targeted(), (await get()).hash as string)).rejects.toThrow(/SecretRef/);

      // The fix, in regenerate's order: the bridge, then secrets.json.
      writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, "acme-llm": { apiKey: "sk-acme" } });
      const bridge = keylessBridge(JSON.parse(readFileSync(ocConfigPath, "utf-8")), authoritative);
      expect(bridge, "the file names a key the bundle lacks").not.toBeNull();
      const bridgeContent = JSON.stringify(bridge, null, 2).trimEnd() + "\n";
      writeFileSync(ocConfigPath, bridgeContent, { mode: 0o666 });
      writeSecretsFile(authoritative);

      // A restart in the window starts — and keeps the bridge: it is not a
      // suspicious read (over half of last-known-good), so nothing is restored.
      const started = (await startOpenClaw()) as { models: { providers: Record<string, Json> } };
      expect(readFileSync(ocConfigPath, "utf-8")).toBe(bridgeContent);
      expect(started.models.providers["acme-llm"]).not.toHaveProperty("apiKey");
      expect(started.models.providers["acme-llm"].models).toHaveLength(40);
      // A targeted writer's copy of the file is accepted.
      await apply(targeted(), (await get()).hash as string);
      expect(
        Object.keys(
          (JSON.parse(readFileSync(ocConfigPath, "utf-8")) as { agents: { entries: Json } }).agents
            .entries
        )
      ).toHaveLength(2);

      // The deletion then lands in steps from there…
      mockGetClient.mockReturnValue({ config: { get, apply }, request: agentsRequest(handlers) });
      pushConfigInBackground(JSON.stringify(target, null, 2), { fullRegenerate: true });
      for (let i = 0; i < 2000 && getPendingConfigPushCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(getPendingConfigPushCount()).toBe(0);
      expect(errorSpy.mock.calls.flat().join(" ")).toBe("");
      const final = JSON.parse(readFileSync(ocConfigPath, "utf-8")) as {
        models: { providers: Json };
      };
      expect(final.models.providers).not.toHaveProperty("acme-llm");
      await startOpenClaw();
      // …and the key was never anywhere again after the regenerate.
      expect(JSON.parse(unreadableToPinchy.readAsOpenClaw(secretsPath))).toEqual(authoritative);
      expect(existsSync(pinchyConfigPath), "the push wrote no file itself").toBe(false);
    } finally {
      delete process.env.OPENCLAW_SECRETS_PATH;
    }
  }, 60_000);

  // Before this fix, regenerate dropped the key from secrets.json while the
  // file still named it, and nothing repaired that. Such an install restarts
  // into a crash loop ("required secrets are unavailable"), and since OpenClaw
  // only starts after Pinchy is healthy, Pinchy's boot regenerate runs with no
  // client. It writes the bridge (openclaw-config.test.ts: the build.ts wiring);
  // here, that OpenClaw then starts on it. The same holds after a full-stack
  // restart while a deletion was pending: the secrets volume is tmpfs, and
  // Pinchy rebuilds secrets.json from the database, without the key.
  it("starts an install whose file names a key secrets.json already lost, once Pinchy wrote the bridge", async () => {
    process.env.OPENCLAW_CONFIG_PATH = pinchyConfigPath;
    const { keylessBridge } = await import("@/lib/openclaw-config/keyless-bridge");
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    const { writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
    type OcConfig = Parameters<typeof writeConfigFile>[0];
    writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, "acme-llm": { apiKey: "sk-acme" } });
    await writeConfigFile(config({ "acme-llm": acme() }) as OcConfig, SEED);
    await promoteToLastKnownGood();
    // The state the old regenerate left behind.
    const bundle = { providers: { anthropic: { apiKey: "sk-ant-test" } } };
    writeSecrets(bundle.providers);
    await expect(startOpenClaw()).rejects.toThrow(/required secrets are unavailable/);

    const bridge = keylessBridge(JSON.parse(readFileSync(ocConfigPath, "utf-8")), bundle);
    writeFileSync(ocConfigPath, JSON.stringify(bridge, null, 2).trimEnd() + "\n", { mode: 0o666 });

    const started = (await startOpenClaw()) as { models: { providers: Record<string, Json> } };
    expect(Object.keys(started.models.providers).sort()).toEqual(["acme-llm", "anthropic"]);
    expect(started.models.providers["acme-llm"]).not.toHaveProperty("apiKey");
  }, 60_000);

  // The #311 guard refuses a regenerate whose kept Ollama catalogue collapsed
  // to `[]` (Ollama not up yet), and it judges that collapse in full even next
  // to a deletion. After a host reboot the secrets volume (tmpfs) is empty,
  // and while OpenClaw is down nothing but the next admin change or Pinchy
  // restart regenerates — refused the same way while Ollama stays down. So a
  // refusal still writes the key-less bridge, built from the on-disk file
  // (catalogue and all), and then secrets.json (openclaw-config.test.ts: the
  // build.ts wiring). Here, that OpenClaw starts on what that leaves it.
  it("starts after a reboot with a deletion pending and Ollama down, from what a refused regenerate writes", async () => {
    process.env.OPENCLAW_CONFIG_PATH = pinchyConfigPath;
    process.env.OPENCLAW_SECRETS_PATH = secretsPath;
    const { keylessBridge, unresolvedSecretRefs } =
      await import("@/lib/openclaw-config/keyless-bridge");
    const { sizeGuardBaseline } = await import("@/lib/openclaw-config/size-drop");
    const { writeSecretsFile } = await import("@/lib/openclaw-secrets");
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    const { writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
    type OcConfig = Parameters<typeof writeConfigFile>[0];
    const ollama = (models: Json[]) => ({
      baseUrl: "http://host.docker.internal:11434/v1",
      request: { allowPrivateNetwork: true },
      api: "openai-completions",
      models,
    });
    const ollamaModels = Array.from({ length: 80 }, (_, i) => ({
      id: `qwen2.5-coder-instruct-variant-${i}:32b-q4_K_M`,
      name: `qwen2.5-coder-instruct-variant-${i}:32b-q4_K_M`,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
    }));
    try {
      writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, "acme-llm": { apiKey: "sk-acme" } });
      await writeConfigFile(
        config({ "acme-llm": acme(), ollama: ollama(ollamaModels) }) as OcConfig,
        SEED
      );
      await promoteToLastKnownGood();
      const onDiskContent = readFileSync(ocConfigPath, "utf-8");
      const onDisk = JSON.parse(onDiskContent) as Json;

      // The reboot: the tmpfs secrets volume comes back empty.
      rmSync(secretsPath);
      await expect(startOpenClaw(), "nothing to resolve the file's keys against").rejects.toThrow(
        /required secrets are unavailable/
      );

      // Pinchy's boot regenerate: acme was deleted, Ollama answers `[]`.
      const bundle = { providers: { anthropic: { apiKey: "sk-ant-test" } } };
      const payload = JSON.stringify(config({ ollama: ollama([]) }), null, 2).trimEnd() + "\n";
      expect(payload.length, "precondition: the #311 guard refuses this payload").toBeLessThan(
        sizeGuardBaseline(onDiskContent, JSON.parse(payload) as Json) * 0.5
      );
      expect(unresolvedSecretRefs(onDisk, bundle), "precondition: a deletion is pending").toEqual([
        "/providers/acme-llm/apiKey",
      ]);

      // What the refusal writes, in its order: the bridge, then secrets.json.
      const bridge = keylessBridge(onDisk, bundle);
      expect(bridge).not.toBeNull();
      const bridgeContent = JSON.stringify(bridge, null, 2).trimEnd() + "\n";
      writeFileSync(ocConfigPath, bridgeContent, { mode: 0o666 });
      writeSecretsFile(bundle);

      // OpenClaw starts on it, keeps it (over half of last-known-good, so not
      // a suspicious read), and resolves every SecretRef in it.
      const started = (await startOpenClaw()) as { models: { providers: Record<string, Json> } };
      expect(readFileSync(ocConfigPath, "utf-8")).toBe(bridgeContent);
      expect(started.models.providers["acme-llm"]).not.toHaveProperty("apiKey");
      expect(started.models.providers["acme-llm"].models).toHaveLength(40);
      expect(started.models.providers.ollama.models).toHaveLength(80);
      expect(JSON.parse(unreadableToPinchy.readAsOpenClaw(secretsPath))).toEqual(bundle);
    } finally {
      delete process.env.OPENCLAW_SECRETS_PATH;
    }
  }, 60_000);

  // #1238 versions an OpenAI-compatible provider's key slot
  // (`/providers/<slug>@<version>/apiKey`), so re-keying it puts a NEW slot in
  // secrets.json and takes the old one out — while openclaw.json still names
  // the old one. An earlier fix kept the old slot in secrets.json for that
  // window, reading its value back from the file; Pinchy cannot read it in
  // production, so it kept nothing (nor here: the fs mock at the top). Here, in
  // regenerate's order (superseded-secret-slot.test.ts pins it): the key-less
  // bridge, secrets.json, then the provider's entry from the target. After
  // every one of those writes OpenClaw starts, and accepts a targeted writer's
  // copy of its file; the new key is only ever paired with the new address.
  it("re-keys a provider with secrets.json unreadable to Pinchy, the file resolvable after every write", async () => {
    process.env.OPENCLAW_CONFIG_PATH = pinchyConfigPath;
    process.env.OPENCLAW_SECRETS_PATH = secretsPath;
    const { pushConfigInBackground } = await import("@/lib/openclaw-config/write");
    const { getPendingConfigPushCount } = await import("@/lib/openclaw-config/push-state");
    const { keylessBridge, rekeyedBridge } = await import("@/lib/openclaw-config/keyless-bridge");
    const { writeSecretsFile } = await import("@/lib/openclaw-secrets");
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    const { writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
    type OcConfig = Parameters<typeof writeConfigFile>[0];
    const handlers = await loadConfigHandlers();
    const get = () => request(handlers["config.get"], {});
    const apply = (raw: string, baseHash?: string, options: Json = {}) =>
      strictApply(handlers["config.apply"], { raw, ...(baseHash ? { baseHash } : {}), ...options });
    const OLD_SLOT = "acme-llm@0000000000000001";
    const NEW_SLOT = "acme-llm@0000000000000002";
    const acmeOld = {
      baseUrl: "https://old.acme.example/v1",
      api: "openai-completions",
      apiKey: ref(`/providers/${OLD_SLOT}/apiKey`),
      models: Array.from({ length: 40 }, (_, i) => model(i)),
    };
    const acmeNew = {
      baseUrl: "https://new-gateway.example/v1",
      api: "openai-completions",
      apiKey: ref(`/providers/${NEW_SLOT}/apiKey`),
      models: Array.from({ length: 40 }, (_, i) => model(i)),
    };
    try {
      writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, [OLD_SLOT]: { apiKey: "sk-acme-old" } });
      await writeConfigFile(config({ "acme-llm": acmeOld }) as OcConfig, SEED);
      await promoteToLastKnownGood();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const target = config({ "acme-llm": acmeNew });
      // What regenerate builds after the re-key: the new slot, not the old one.
      const authoritative = {
        providers: { anthropic: { apiKey: "sk-ant-test" }, [NEW_SLOT]: { apiKey: "sk-acme-new" } },
      };
      const onDisk = () => JSON.parse(readFileSync(ocConfigPath, "utf-8")) as Json;
      const targeted = () => {
        const file = onDisk();
        delete file.meta;
        return JSON.stringify({ ...file, agents: { entries: { smithers: { name: "S" } } } });
      };
      /** OpenClaw starts on the file, and accepts a targeted writer's copy of it. */
      const usable = async () => {
        const started = (await startOpenClaw()) as { models: { providers: Record<string, Json> } };
        await apply(targeted(), (await get()).hash as string);
        await promoteToLastKnownGood();
        const acme = started.models.providers["acme-llm"];
        if (JSON.stringify(acme.apiKey ?? null).includes(NEW_SLOT)) {
          expect(acme.baseUrl, "the new key goes to the new address only").toBe(
            "https://new-gateway.example/v1"
          );
        }
        return acme;
      };
      const write = (file: Json) =>
        writeFileSync(ocConfigPath, JSON.stringify(file, null, 2).trimEnd() + "\n", {
          mode: 0o666,
        });

      // The bug: secrets.json written from the database, next to a file that
      // still names the old slot. OpenClaw cannot start, and refuses a copy.
      writeSecretsFile(authoritative);
      await expect(startOpenClaw()).rejects.toThrow(/required secrets are unavailable/);
      await expect(apply(targeted(), (await get()).hash as string)).rejects.toThrow(/SecretRef/);

      // The fix, from the same starting point.
      writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, [OLD_SLOT]: { apiKey: "sk-acme-old" } });
      const before = onDisk();
      const keyless = keylessBridge(before, authoritative)!;
      expect(keyless, "the file names a slot the bundle lacks").not.toBeNull();
      write(keyless);
      expect(await usable()).not.toHaveProperty("apiKey");
      writeSecretsFile(authoritative);
      expect(await usable()).not.toHaveProperty("apiKey");
      const rekeyed = rekeyedBridge(keyless, before, target, authoritative);
      expect(rekeyed, "the provider is kept, so it gets its key back").not.toBeNull();
      write(rekeyed!);
      const acme = await usable();
      expect(acme.apiKey).toEqual(ref(`/providers/${NEW_SLOT}/apiKey`));
      expect(acme.models).toHaveLength(40);

      // The push then finds the provider in place and delivers the rest.
      mockGetClient.mockReturnValue({ config: { get, apply }, request: agentsRequest(handlers) });
      pushConfigInBackground(JSON.stringify(target, null, 2), { fullRegenerate: true });
      for (let i = 0; i < 2000 && getPendingConfigPushCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(getPendingConfigPushCount()).toBe(0);
      expect(errorSpy.mock.calls.flat().join(" ")).toBe("");
      expect(await usable()).toMatchObject({ baseUrl: "https://new-gateway.example/v1" });
      expect(JSON.parse(unreadableToPinchy.readAsOpenClaw(secretsPath))).toEqual(authoritative);
      expect(existsSync(pinchyConfigPath), "the push wrote no file itself").toBe(false);
    } finally {
      delete process.env.OPENCLAW_SECRETS_PATH;
    }
  }, 60_000);
  // The same re-key, to an address that serves a much smaller catalogue (a
  // large OpenRouter list → a small endpoint). Its payload shrinks a KEPT
  // provider, so the #311 guard refuses it — and the refusal still writes the
  // bridge, secrets.json and the re-keyed entry. Written as the target has it,
  // that entry took the file far under half of last-known-good, and OpenClaw's
  // read path restored `.bak`: its own pre-bridge write, naming the old slot
  // secrets.json no longer has — "required secrets are unavailable", and every
  // later regenerate wrote the same state again. Here OpenClaw has written its
  // file twice, so `.bak` exists, and nothing promotes Pinchy's writes: after
  // each of them OpenClaw starts on exactly that file and resolves every ref.
  it("re-keys a provider to a much smaller catalogue without a write OpenClaw's read path reverts", async () => {
    process.env.OPENCLAW_CONFIG_PATH = pinchyConfigPath;
    process.env.OPENCLAW_SECRETS_PATH = secretsPath;
    const { keylessBridge, rekeyedBridge, unresolvedSecretRefs } =
      await import("@/lib/openclaw-config/keyless-bridge");
    const { sizeGuardBaseline, keepsAProvider } = await import("@/lib/openclaw-config/size-drop");
    const { writeSecretsFile } = await import("@/lib/openclaw-secrets");
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    const { writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
    type OcConfig = Parameters<typeof writeConfigFile>[0];
    const OLD_SLOT = "acme-llm@0000000000000001";
    const NEW_SLOT = "acme-llm@0000000000000002";
    const acmeOld = {
      baseUrl: "https://old.acme.example/v1",
      api: "openai-completions",
      apiKey: ref(`/providers/${OLD_SLOT}/apiKey`),
      models: Array.from({ length: 40 }, (_, i) => model(i)),
    };
    const acmeNew = {
      baseUrl: "https://new-gateway.example/v1",
      api: "openai-completions",
      apiKey: ref(`/providers/${NEW_SLOT}/apiKey`),
      models: [{ ...model(0), id: "acme-next" }],
    };
    try {
      writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, [OLD_SLOT]: { apiKey: "sk-acme-old" } });
      await writeConfigFile(config({ "acme-llm": acmeOld }) as OcConfig, SEED);
      await writeConfigFile(
        {
          ...config({ "acme-llm": acmeOld }),
          agents: { entries: { smithers: { name: "Smithers 2" } } },
        } as OcConfig,
        SEED
      );
      await promoteToLastKnownGood();
      expect(existsSync(`${ocConfigPath}.bak`), "precondition: OpenClaw has a .bak").toBe(true);

      const target = config({ "acme-llm": acmeNew });
      const bundle = {
        providers: { anthropic: { apiKey: "sk-ant-test" }, [NEW_SLOT]: { apiKey: "sk-acme-new" } },
      };
      const onDiskContent = readFileSync(ocConfigPath, "utf-8");
      const before = JSON.parse(onDiskContent) as Json;
      const payload = JSON.stringify(target, null, 2).trimEnd() + "\n";
      expect(
        payload.length < sizeGuardBaseline(onDiskContent, target) * 0.5 && keepsAProvider(target),
        "precondition: the #311 guard refuses the payload, and still writes the bridge"
      ).toBe(true);
      expect(unresolvedSecretRefs(before, bundle)).toEqual([`/providers/${OLD_SLOT}/apiKey`]);

      /** OpenClaw starts on exactly the file Pinchy wrote, and resolves every ref in it. */
      const startsOn = async (written: string) => {
        const started = (await startOpenClaw()) as { models: { providers: Record<string, Json> } };
        expect(readFileSync(ocConfigPath, "utf-8"), "OpenClaw kept Pinchy's write").toBe(written);
        return started.models.providers["acme-llm"];
      };
      const write = (file: Json) => {
        const content = JSON.stringify(file, null, 2).trimEnd() + "\n";
        writeFileSync(ocConfigPath, content, { mode: 0o666 });
        return content;
      };

      // The refusal's writes, in regenerate's order.
      const keyless = keylessBridge(before, bundle)!;
      const keylessContent = write(keyless);
      expect(await startsOn(keylessContent)).not.toHaveProperty("apiKey");
      writeSecretsFile(bundle);
      expect(await startsOn(keylessContent)).not.toHaveProperty("apiKey");
      const rekeyed = rekeyedBridge(keyless, before, target, bundle);
      expect(rekeyed, "the provider is kept, so it gets its key back").not.toBeNull();
      const acme = await startsOn(write(rekeyed!));
      expect(acme.apiKey).toEqual(ref(`/providers/${NEW_SLOT}/apiKey`));
      expect(acme.baseUrl).toBe("https://new-gateway.example/v1");
      expect((acme.models as Json[]).map((m) => m.id)).toContain("acme-next");
    } finally {
      delete process.env.OPENCLAW_SECRETS_PATH;
    }
  }, 60_000);

  // A re-key whose target is just over half of the file: the #311 guard passes
  // it and it is pushed, but written whole its entry would sit inside the
  // headroom rekeyedBridge keeps over OpenClaw's read-side line. Carrying ALL
  // the file's models then left the file larger than before the re-key:
  // OpenClaw refused the push's target as a size drop against it (no deleted
  // provider to step, so the push was dropped), and every later regenerate was
  // refused by the #311 guard against the enlarged file — "refused forever",
  // where main's config.apply of the same target went through. This band is
  // probed against the real handlers here.
  it("re-keys a provider to a catalogue just over half of the file, and the push lands", async () => {
    process.env.OPENCLAW_CONFIG_PATH = pinchyConfigPath;
    process.env.OPENCLAW_SECRETS_PATH = secretsPath;
    const { pushConfigInBackground } = await import("@/lib/openclaw-config/write");
    const { getPendingConfigPushCount } = await import("@/lib/openclaw-config/push-state");
    const { keylessBridge, rekeyedBridge } = await import("@/lib/openclaw-config/keyless-bridge");
    const { sizeGuardBaseline, expectsSizeDropRefusal } =
      await import("@/lib/openclaw-config/size-drop");
    const { writeSecretsFile } = await import("@/lib/openclaw-secrets");
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    const { writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
    type OcConfig = Parameters<typeof writeConfigFile>[0];
    const handlers = await loadConfigHandlers();
    const get = () => request(handlers["config.get"], {});
    const apply = (raw: string, baseHash?: string) =>
      strictApply(handlers["config.apply"], { raw, ...(baseHash ? { baseHash } : {}) });
    const OLD_SLOT = "acme-llm@0000000000000001";
    const NEW_SLOT = "acme-llm@0000000000000002";
    const acmeOld = {
      baseUrl: "https://old.acme.example/v1",
      api: "openai-completions",
      apiKey: ref(`/providers/${OLD_SLOT}/apiKey`),
      models: Array.from({ length: 40 }, (_, i) => model(i)),
    };
    // Disjoint from the old catalogue: the new address serves other models.
    const acmeNew = (n: number) => ({
      baseUrl: "https://new-gateway.example/v1",
      api: "openai-completions",
      apiKey: ref(`/providers/${NEW_SLOT}/apiKey`),
      models: Array.from({ length: n }, (_, i) => ({
        ...model(i),
        id: `new-${i}-with-a-realistically-long-identifier`,
        name: `New ${i} (display)`,
      })),
    });
    const bundle = {
      providers: { anthropic: { apiKey: "sk-ant-test" }, [NEW_SLOT]: { apiKey: "sk-acme-new" } },
    };
    const serialize = (file: Json) => JSON.stringify(file, null, 2).trimEnd() + "\n";
    const write = (file: Json) => {
      const content = serialize(file);
      writeFileSync(ocConfigPath, content, { mode: 0o666 });
      return content;
    };
    /** OpenClaw's file and last-known-good as before the re-key, with a `.bak`. */
    const installOld = async () => {
      writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, [OLD_SLOT]: { apiKey: "sk-acme-old" } });
      await writeConfigFile(config({ "acme-llm": acmeOld }) as OcConfig, SEED);
      await writeConfigFile(
        {
          ...config({ "acme-llm": acmeOld }),
          agents: { entries: { smithers: { name: "Smithers 2" } } },
        } as OcConfig,
        SEED
      );
      await promoteToLastKnownGood();
      return readFileSync(ocConfigPath, "utf-8");
    };
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockGetClient.mockReturnValue({ config: { get, apply }, request: agentsRequest(handlers) });

      // The band: a target the #311 guard passes, whose entry written whole
      // would still be inside the headroom over OpenClaw's read-side line.
      const reference = await installOld();
      const keylessOf = (content: string) => keylessBridge(JSON.parse(content) as Json, bundle)!;
      const band = Array.from({ length: 40 }, (_, i) => i + 1).filter((n) => {
        const target = config({ "acme-llm": acmeNew(n) });
        const keyless = keylessOf(reference);
        const exact = {
          ...keyless,
          models: {
            ...(keyless.models as Json),
            providers: { ...((keyless.models as Json).providers as Json), "acme-llm": acmeNew(n) },
          },
        };
        return (
          serialize(target).length >= sizeGuardBaseline(reference, target) * 0.5 &&
          expectsSizeDropRefusal(reference, serialize(exact))
        );
      });
      expect(band.length, "precondition: the band holds some catalogue sizes").toBeGreaterThan(0);

      for (const n of band) {
        const onDiskContent = await installOld();
        const before = JSON.parse(onDiskContent) as Json;
        const target = config({ "acme-llm": acmeNew(n) });

        // Regenerate's writes, in its order; OpenClaw starts on each as written.
        const keyless = keylessBridge(before, bundle)!;
        write(keyless);
        writeSecretsFile(bundle);
        const rekeyed = rekeyedBridge(keyless, before, target, bundle)!;
        const written = write(rekeyed);
        await startOpenClaw();
        expect(readFileSync(ocConfigPath, "utf-8"), `n=${n}: OpenClaw kept Pinchy's write`).toBe(
          written
        );
        await promoteToLastKnownGood();

        // The push of the exact target lands over config.apply.
        errorSpy.mockClear();
        pushConfigInBackground(JSON.stringify(target, null, 2), { fullRegenerate: true });
        for (let i = 0; i < 2000 && getPendingConfigPushCount() > 0; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        expect(getPendingConfigPushCount()).toBe(0);
        expect(errorSpy.mock.calls.flat().join(" "), `n=${n}: no push error`).toBe("");
        const landed = (await startOpenClaw()) as { models: { providers: Record<string, Json> } };
        expect(
          (landed.models.providers["acme-llm"].models as Json[]).map((m) => m.id),
          `n=${n}: OpenClaw runs exactly the new catalogue`
        ).toEqual(acmeNew(n).models.map((m) => m.id));

        // And the next regenerate's #311 guard passes against the file it left.
        const fileNow = readFileSync(ocConfigPath, "utf-8");
        const next = serialize(target);
        expect(next.length, `n=${n}: the next regenerate is not refused`).toBeGreaterThanOrEqual(
          sizeGuardBaseline(fileNow, target) * 0.5
        );
      }
      expect(existsSync(pinchyConfigPath), "the push wrote no file itself").toBe(false);
    } finally {
      delete process.env.OPENCLAW_SECRETS_PATH;
    }
  }, 120_000);

  // OpenClaw promotes last-known-good only while it runs (its reloader, and
  // once at startup). With OpenClaw down, every Pinchy write lands on top of a
  // last-known-good that is still the file from before the FIRST of them. The
  // re-keyed file (rekeyedBridge) sits just above half of that file — so a
  // second write, judged only against the re-keyed file on disk, could fall far
  // under half of last-known-good, and OpenClaw's next start restored `.bak`,
  // which names the old slot secrets.json no longer holds: "required secrets
  // are unavailable", a crash loop until the next regenerate. Both sequences
  // are run against the real handlers here.
  describe("with OpenClaw down across several Pinchy writes", () => {
    const OLD_SLOT = "acme-llm@0000000000000001";
    const NEW_SLOT = "acme-llm@0000000000000002";
    const NEWER_SLOT = "acme-llm@0000000000000003";
    const serialize = (file: Json) => JSON.stringify(file, null, 2).trimEnd() + "\n";
    const bytes = (content: string) => Buffer.byteLength(content, "utf-8");
    const acmeAt = (slot: string, url: string, models: Json[]) => ({
      baseUrl: url,
      api: "openai-completions",
      apiKey: ref(`/providers/${slot}/apiKey`),
      models,
    });
    // Disjoint from the old catalogue: the new address serves other models.
    const catalogue = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...model(i),
        id: `${prefix}-${i}-with-a-realistically-long-identifier`,
        name: `${prefix} ${i} (display)`,
      }));
    const bundleFor = (slot: string) => ({
      providers: { anthropic: { apiKey: "sk-ant-test" }, [slot]: { apiKey: `sk-${slot}` } },
    });

    /**
     * Pinchy as a (re)started process loads it: fresh module instances and no
     * process-wide state — only what is on disk survives.
     */
    async function startPinchy() {
      vi.resetModules();
      endPinchyProcess();
      process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
      process.env.OPENCLAW_SECRETS_PATH = secretsPath;
      return {
        ...(await import("@/lib/openclaw-config/write")),
        ...(await import("@/lib/openclaw-config/keyless-bridge")),
        ...(await import("@/lib/openclaw-config/size-drop")),
        ...(await import("@/lib/openclaw-config/push-state")),
        ...(await import("@/lib/openclaw-config/last-good-bound")),
        ...(await import("@/lib/openclaw-secrets")),
        ...(await import("@/server/openclaw-connect-regenerate")),
      };
    }
    type Pinchy = Awaited<ReturnType<typeof startPinchy>>;

    /** OpenClaw's file and last-known-good before the re-key, with a `.bak`; then it stops. */
    async function installOld(): Promise<string> {
      const { writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
      type OcConfig = Parameters<typeof writeConfigFile>[0];
      const acmeOld = acmeAt(
        OLD_SLOT,
        "https://old.acme.example/v1",
        Array.from({ length: 40 }, (_, i) => model(i))
      );
      writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, [OLD_SLOT]: { apiKey: "sk-acme-old" } });
      await writeConfigFile(config({ "acme-llm": acmeOld }) as OcConfig, SEED);
      await writeConfigFile(
        {
          ...config({ "acme-llm": acmeOld }),
          agents: { entries: { smithers: { name: "Smithers 2" } } },
        } as OcConfig,
        SEED
      );
      await promoteToLastKnownGood();
      return readFileSync(ocConfigPath, "utf-8");
    }

    /**
     * OpenClaw starting on the file now on disk — in a copy of its state, so
     * nothing it observes or promotes carries over: it stays down.
     */
    async function startsOnCopy(): Promise<{ file: string; acme: Json }> {
      const copy = mkdtempSync(join(tmpdir(), "pinchy-oc-start-"));
      cpSync(dir, copy, { recursive: true });
      process.env.OPENCLAW_STATE_DIR = copy;
      process.env.OPENCLAW_CONFIG_PATH = join(copy, "openclaw.json");
      try {
        const started = (await startOpenClaw()) as { models: { providers: Record<string, Json> } };
        return {
          file: readFileSync(join(copy, "openclaw.json"), "utf-8"),
          acme: started.models.providers["acme-llm"],
        };
      } finally {
        process.env.OPENCLAW_STATE_DIR = dir;
        process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
        rmSync(copy, { recursive: true, force: true });
      }
    }

    /** Waits until no push is in flight. */
    async function settle(pinchy: Pinchy) {
      for (let i = 0; i < 2000 && pinchy.getPendingConfigPushCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(pinchy.getPendingConfigPushCount()).toBe(0);
    }

    /**
     * A refused or passing regenerate's file writes for a re-key, in build.ts's
     * order, through Pinchy's own writer. After each, OpenClaw starts on
     * exactly that file and resolves every SecretRef in it.
     */
    async function rekeyWrites(pinchy: Pinchy, target: Json, slot: string) {
      const onDiskContent = readFileSync(ocConfigPath, "utf-8");
      const onDisk = JSON.parse(onDiskContent) as Json;
      const bundle = bundleFor(slot);
      const keyless = pinchy.keylessBridge(onDisk, bundle)!;
      expect(keyless, "the file names a slot the bundle lacks").not.toBeNull();
      pinchy.writeConfigAtomic(serialize(keyless));
      expect((await startsOnCopy()).file).toBe(serialize(keyless));
      pinchy.writeSecretsFile(bundle);
      pinchy.recordWrittenSecrets(bundle);
      expect((await startsOnCopy()).file).toBe(serialize(keyless));
      const rekeyed = pinchy.rekeyedBridge(
        keyless,
        onDisk,
        target,
        bundle,
        pinchy.readSideBaselineBytes(onDiskContent)
      )!;
      pinchy.writeConfigAtomic(serialize(rekeyed));
      const started = await startsOnCopy();
      expect(started.file, "OpenClaw keeps the re-keyed file").toBe(serialize(rekeyed));
      expect(started.acme.apiKey).toEqual(ref(`/providers/${slot}/apiKey`));
    }

    /**
     * OpenClaw comes up on the file and Pinchy connects — for the first time
     * since Pinchy started, or again — and the regenerate that connect runs
     * (regenerateOnConnect) delivers `target`, the config rebuilt from the
     * database.
     */
    async function openClawComesUp(
      pinchy: Pinchy,
      target: Json,
      { firstConnect }: { firstConnect: boolean }
    ) {
      await startOpenClaw();
      await promoteToLastKnownGood();
      const handlers = await loadConfigHandlers();
      const get = () => request(handlers["config.get"], {});
      const apply = (raw: string, baseHash?: string) =>
        strictApply(handlers["config.apply"], { raw, ...(baseHash ? { baseHash } : {}) });
      mockGetClient.mockReturnValue({ config: { get, apply }, request: agentsRequest(handlers) });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const regenerate = vi.fn(() => {
        pinchy.pushConfigInBackground(serialize(target), {
          fullRegenerate: true,
          regenerateSeq: pinchy.nextRegenerateSequence(),
        });
        return Promise.resolve();
      });
      pinchy.regenerateOnConnect({ firstConnect }, regenerate);
      expect(regenerate, "the connect regenerates").toHaveBeenCalledTimes(1);
      await settle(pinchy);
      expect(errorSpy.mock.calls.flat().join(" "), "the push lands").toBe("");
      expect(pinchy.undeliveredConfigChange(), "nothing is owed any more").toBe(false);
      const landed = (await startOpenClaw()) as { models: { providers: Record<string, Json> } };
      return landed.models.providers["acme-llm"];
    }

    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      delete process.env.OPENCLAW_SECRETS_PATH;
      endPinchyProcess();
    });

    const rekeyTarget = (n: number) =>
      config({
        "acme-llm": acmeAt(NEW_SLOT, "https://new-gateway.example/v1", catalogue("new", n)),
      });

    /**
     * A catalogue size the #311 guard refuses against the installed file, but
     * passes against the re-keyed file that refusal leaves behind — and that
     * is under half of OpenClaw's last-known-good.
     */
    function catalogueUnderTheLine(pinchy: Pinchy, installed: string): number {
      const keyless = pinchy.keylessBridge(JSON.parse(installed) as Json, bundleFor(NEW_SLOT))!;
      const n = Array.from({ length: 39 }, (_, i) => i + 1).find((k) => {
        const payload = serialize(rekeyTarget(k));
        const reKeyed = serialize(
          pinchy.rekeyedBridge(
            keyless,
            JSON.parse(installed) as Json,
            rekeyTarget(k),
            bundleFor(NEW_SLOT)
          )!
        );
        return (
          payload.length < pinchy.sizeGuardBaseline(installed, rekeyTarget(k)) * 0.5 &&
          payload.length >= pinchy.sizeGuardBaseline(reKeyed, rekeyTarget(k)) * 0.5 &&
          bytes(payload) < Math.floor(bytes(installed) * 0.5)
        );
      });
      expect(n, "precondition: such a catalogue exists").toBeDefined();
      return n!;
    }

    it("keeps a file OpenClaw starts on through a refused re-key, a Pinchy restart and the next regenerate", async () => {
      let pinchy = await startPinchy();
      const installed = await installOld();
      const target = rekeyTarget;
      const n = catalogueUnderTheLine(pinchy, installed);

      // Regenerate 1, refused by the #311 guard; OpenClaw is down.
      await rekeyWrites(pinchy, target(n), NEW_SLOT);

      // Pinchy restarts. Its boot regenerate (no client yet) passes the #311
      // guard against the re-keyed file and deletes no provider, so nothing
      // but the push stands between its target and the file.
      pinchy = await startPinchy();
      pinchy.recordWrittenSecrets(bundleFor(NEW_SLOT));
      mockGetClient.mockReturnValue(undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const reKeyedFile = readFileSync(ocConfigPath, "utf-8");
      pinchy.pushConfigInBackground(serialize(target(n)), { fullRegenerate: true });
      await settle(pinchy);
      const started = await startsOnCopy();
      expect(started.file, "OpenClaw starts on the file Pinchy left").toBe(
        readFileSync(ocConfigPath, "utf-8")
      );
      expect(started.acme.apiKey).toEqual(ref(`/providers/${NEW_SLOT}/apiKey`));
      expect(readFileSync(ocConfigPath, "utf-8"), "the target waits for config.apply").toBe(
        reKeyedFile
      );
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/last-known-good/);
      errorSpy.mockRestore();

      // OpenClaw comes up on it, and the target lands over config.apply.
      const acme = await openClawComesUp(pinchy, target(n), { firstConnect: true });
      expect((acme.models as Json[]).map((m) => m.id)).toEqual(
        catalogue("new", n).map((m) => m.id)
      );
      expect(acme.apiKey).toEqual(ref(`/providers/${NEW_SLOT}/apiKey`));
    }, 120_000);

    // The same refused re-key and the same next regenerate, with no Pinchy
    // restart in between: Pinchy connected to OpenClaw before it stopped, so
    // its return is a reconnect, and a reconnect regenerates only when a
    // change is owed. The refused file write owes one.
    it("delivers a regenerate refused while OpenClaw is down when OpenClaw reconnects", async () => {
      const pinchy = await startPinchy();
      const installed = await installOld();
      const n = catalogueUnderTheLine(pinchy, installed);
      await rekeyWrites(pinchy, rekeyTarget(n), NEW_SLOT);

      // The next regenerate's push, with OpenClaw still down.
      mockGetClient.mockReturnValue(undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const reKeyedFile = readFileSync(ocConfigPath, "utf-8");
      pinchy.pushConfigInBackground(serialize(rekeyTarget(n)), {
        fullRegenerate: true,
        regenerateSeq: pinchy.nextRegenerateSequence(),
      });
      await settle(pinchy);
      expect(readFileSync(ocConfigPath, "utf-8"), "precondition: refused").toBe(reKeyedFile);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/last-known-good/);
      errorSpy.mockRestore();

      const acme = await openClawComesUp(pinchy, rekeyTarget(n), { firstConnect: false });
      expect((acme.models as Json[]).map((m) => m.id)).toEqual(
        catalogue("new", n).map((m) => m.id)
      );
      expect(acme.apiKey).toEqual(ref(`/providers/${NEW_SLOT}/apiKey`));
    }, 120_000);

    // A host reboot empties the secrets tmpfs; OpenClaw starts only once
    // Pinchy is healthy. With the deleted provider's key still named by the
    // file and the bridge under a persisted bound, the bridge waits for
    // config.apply — which needs an OpenClaw that starts on that file. It
    // judges the file by its own last-known-good at startup (its health state
    // and `.bak`, never Pinchy's bound), keeps it, and resolves every SecretRef
    // in it: the kept keys and the removed one alike (build.ts:
    // keepOnDiskConfigResolvable).
    it("starts after a host reboot on a file naming a deleted provider's key, while the bridge waits for config.apply", async () => {
      let pinchy = await startPinchy();
      const installed = await installOld();
      writeFileSync(
        pinchy.LAST_GOOD_BOUND_PATH,
        JSON.stringify({ bytes: 2 * bytes(installed) - 1 }) + "\n"
      );
      rmSync(secretsPath);
      pinchy = await startPinchy();
      const onDisk = JSON.parse(installed) as Json;
      const bundle = { providers: { anthropic: { apiKey: "sk-ant-test" } } };
      expect(
        () => pinchy.writeConfigAtomic(serialize(pinchy.keylessBridge(onDisk, bundle)!)),
        "precondition: the bridge falls under the bound"
      ).toThrow(pinchy.UnderReadSideLineError);

      // secrets.json as the database has it cannot start OpenClaw on this file.
      pinchy.writeSecretsFile(bundle);
      await expect(startsOnCopy()).rejects.toThrow(/required secrets are unavailable/);

      pinchy.writeSecretsFile(pinchy.withRemovedKeyPlaceholders(onDisk, bundle));
      const started = await startsOnCopy();
      expect(started.file, "OpenClaw keeps the file").toBe(installed);
      expect(started.acme.apiKey).toEqual(ref(`/providers/${OLD_SLOT}/apiKey`));

      // It comes up, Pinchy connects, and the deletion lands.
      const target = config();
      mockGetClient.mockReturnValue(undefined);
      const acme = await openClawComesUp(pinchy, target, { firstConnect: true });
      expect(acme, "the deleted provider is gone").toBeUndefined();
      // The regenerate after it writes secrets.json from the database again.
      pinchy.writeSecretsFile(bundle);
      const restarted = (await startOpenClaw()) as { models: { providers: Record<string, Json> } };
      expect(Object.keys(restarted.models.providers)).toEqual(["anthropic"]);
    }, 120_000);

    it("keeps a file OpenClaw starts on through two re-keys in a row, with a Pinchy restart between them", async () => {
      let pinchy = await startPinchy();
      const installed = await installOld();
      const small = (slot: string, prefix: string) =>
        config({ "acme-llm": acmeAt(slot, `https://${prefix}.example/v1`, catalogue(prefix, 10)) });
      expect(
        bytes(serialize(small(NEWER_SLOT, "newer"))),
        "precondition: the second target is under half of last-known-good"
      ).toBeLessThan(Math.floor(bytes(installed) * 0.5));

      await rekeyWrites(pinchy, small(NEW_SLOT, "new"), NEW_SLOT);
      pinchy = await startPinchy();
      await rekeyWrites(pinchy, small(NEWER_SLOT, "newer"), NEWER_SLOT);

      // The second regenerate's push, with OpenClaw still down.
      mockGetClient.mockReturnValue(undefined);
      vi.spyOn(console, "error").mockImplementation(() => {});
      pinchy.pushConfigInBackground(serialize(small(NEWER_SLOT, "newer")), {
        fullRegenerate: true,
      });
      await settle(pinchy);
      const started = await startsOnCopy();
      expect(started.file).toBe(readFileSync(ocConfigPath, "utf-8"));
      expect(started.acme.apiKey).toEqual(ref(`/providers/${NEWER_SLOT}/apiKey`));
      vi.mocked(console.error).mockRestore();

      const acme = await openClawComesUp(pinchy, small(NEWER_SLOT, "newer"), {
        firstConnect: true,
      });
      expect((acme.models as Json[]).map((m) => m.id)).toEqual(
        catalogue("newer", 10).map((m) => m.id)
      );
    }, 120_000);
  });
});
