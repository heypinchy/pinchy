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
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

const mockGetClient = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

// In production Pinchy cannot read secrets.json: start-openclaw.sh's 50 ms
// fix-config-permissions tick chowns it to root:root 0600, and Pinchy runs as
// uid 999. Nothing here may depend on reading it, so here it cannot be read.
vi.mock("@/lib/openclaw-secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-secrets")>()),
  readSecretsFile: () => {
    throw Object.assign(new Error("EACCES: permission denied, open 'secrets.json'"), {
      code: "EACCES",
    });
  },
}));

type Json = Record<string, unknown>;

type Respond = (ok: boolean, payload?: unknown, error?: { message?: string }) => void;
type ConfigHandler = (opts: {
  params: Json;
  respond: Respond;
  client: null;
  context: undefined;
}) => unknown;

/** The pinned package's dist/ (`openclaw/plugin-sdk/config-runtime` is public and lives in dist/plugin-sdk/). */
function openClawDist(): string {
  const require = createRequire(import.meta.url);
  return dirname(dirname(require.resolve("openclaw/plugin-sdk/config-runtime")));
}

/** The one dist/ chunk that exports `name` under that name. Fails loudly if a bump moves it. */
async function importChunkExporting<T>(name: string): Promise<T> {
  const dist = openClawDist();
  const exports = new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\}`);
  const exporting = readdirSync(dist).filter(
    (f) => f.endsWith(".js") && exports.test(readFileSync(join(dist, f), "utf-8"))
  );
  expect(exporting, `exactly one chunk in ${dist} must export ${name}`).toHaveLength(1);
  return (await import(pathToFileURL(join(dist, exporting[0])).href)) as T;
}

/** OpenClaw's gateway `configHandlers`, from the pinned package's dist/. */
async function loadConfigHandlers(): Promise<Record<string, ConfigHandler>> {
  const mod = await importChunkExporting<{ configHandlers: Record<string, ConfigHandler> }>(
    "configHandlers"
  );
  expect(Object.keys(mod.configHandlers)).toEqual(
    expect.arrayContaining(["config.get", "config.apply"])
  );
  return mod.configHandlers;
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
 * "startup"), which throws "Startup failed: required secrets are unavailable"
 * on a SecretRef the secrets file cannot resolve. Resolves with the config it
 * would run.
 */
async function startOpenClaw(): Promise<Json> {
  const oc = await loadOcConfigModule();
  const { snapshot } = await oc.readConfigFileSnapshotWithPluginMetadata({
    isolateEnv: true,
    recoverSuspicious: true,
  });
  expect(snapshot.valid, "OpenClaw's startup read must find a valid config").toBe(true);
  type Activate = (config: Json, params: { reason: string; activate: boolean }) => Promise<unknown>;
  const { createRuntimeSecretsActivator } = await importChunkExporting<{
    createRuntimeSecretsActivator: (params: Json) => Activate;
  }>("createRuntimeSecretsActivator");
  const silent = { info: () => {}, warn: () => {}, error: () => {} };
  const activate = createRuntimeSecretsActivator({ logSecrets: silent, emitStateEvent: () => {} });
  await activate(snapshot.config, { reason: "startup", activate: false });
  return snapshot.config;
}

/** One gateway request: resolves with the response, or rejects the way the client does. */
function request(handler: ConfigHandler, params: Json): Promise<Json> {
  return new Promise((resolve, reject) => {
    const respond: Respond = (ok, payload, error) =>
      ok ? resolve(payload as Json) : reject(new Error(error?.message ?? "request failed"));
    Promise.resolve(handler({ params, respond, client: null, context: undefined })).catch(
      (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)))
    );
  });
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
      agents: { list: [{ id: "smithers", name: "Smithers" }] },
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
    process.env.OPENCLAW_STATE_DIR = dir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
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
      request(handlers["config.apply"], { raw, ...(baseHash ? { baseHash } : {}), ...options });

    writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, "acme-llm": { apiKey: "sk-acme" } });
    await writeConfigFile(config({ "acme-llm": acme() }) as OcConfig);
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
  // — in production it cannot (root:root 0600; see the mock at the top).
  it("leaves OpenClaw a file it can restart on and apply while a deletion is handed over", async () => {
    process.env.OPENCLAW_CONFIG_PATH = pinchyConfigPath;
    process.env.OPENCLAW_SECRETS_PATH = secretsPath;
    const { pushConfigInBackground } = await import("@/lib/openclaw-config/write");
    const { getPendingConfigPushCount } = await import("@/lib/openclaw-config/push-state");
    const { keylessBridge } = await import("@/lib/openclaw-config/keyless-bridge");
    const { writeSecretsFile } = await import("@/lib/openclaw-secrets");
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    const { writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
    type OcConfig = Parameters<typeof writeConfigFile>[0];
    const handlers = await loadConfigHandlers();
    const get = () => request(handlers["config.get"], {});
    const apply = (raw: string, baseHash?: string, options: Json = {}) =>
      request(handlers["config.apply"], { raw, ...(baseHash ? { baseHash } : {}), ...options });
    try {
      writeSecrets({ anthropic: { apiKey: "sk-ant-test" }, "acme-llm": { apiKey: "sk-acme" } });
      await writeConfigFile(config({ "acme-llm": acme() }) as OcConfig);
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
              list: [
                { id: "smithers", name: "Smithers" },
                { id: "kb", name: "KB" },
              ],
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
        (JSON.parse(readFileSync(ocConfigPath, "utf-8")) as { agents: { list: Json[] } }).agents
          .list
      ).toHaveLength(2);

      // The deletion then lands in steps from there…
      mockGetClient.mockReturnValue({ config: { get, apply } });
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
      expect(JSON.parse(readFileSync(secretsPath, "utf-8"))).toEqual(authoritative);
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
    await writeConfigFile(config({ "acme-llm": acme() }) as OcConfig);
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
        config({ "acme-llm": acme(), ollama: ollama(ollamaModels) }) as OcConfig
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
      expect(JSON.parse(readFileSync(secretsPath, "utf-8"))).toEqual(bundle);
    } finally {
      delete process.env.OPENCLAW_SECRETS_PATH;
    }
  }, 60_000);

  // #1238 versions an OpenAI-compatible provider's key slot
  // (`/providers/<slug>@<version>/apiKey`), so re-keying it puts a NEW slot in
  // secrets.json and takes the old one out — while openclaw.json still names
  // the old one. An earlier fix kept the old slot in secrets.json for that
  // window, reading its value back from the file; Pinchy cannot read it in
  // production (see the mock at the top), so it kept nothing. Here, in
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
      request(handlers["config.apply"], { raw, ...(baseHash ? { baseHash } : {}), ...options });
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
      await writeConfigFile(config({ "acme-llm": acmeOld }) as OcConfig);
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
        return JSON.stringify({ ...file, agents: { list: [{ id: "smithers", name: "S" }] } });
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
      mockGetClient.mockReturnValue({ config: { get, apply } });
      pushConfigInBackground(JSON.stringify(target, null, 2), { fullRegenerate: true });
      for (let i = 0; i < 2000 && getPendingConfigPushCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(getPendingConfigPushCount()).toBe(0);
      expect(errorSpy.mock.calls.flat().join(" ")).toBe("");
      expect(await usable()).toMatchObject({ baseUrl: "https://new-gateway.example/v1" });
      expect(JSON.parse(readFileSync(secretsPath, "utf-8"))).toEqual(authoritative);
      expect(existsSync(pinchyConfigPath), "the push wrote no file itself").toBe(false);
    } finally {
      delete process.env.OPENCLAW_SECRETS_PATH;
    }
  }, 60_000);
});
