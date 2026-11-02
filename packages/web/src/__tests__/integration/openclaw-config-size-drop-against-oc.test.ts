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

type Json = Record<string, unknown>;

type Respond = (ok: boolean, payload?: unknown, error?: { message?: string }) => void;
type ConfigHandler = (opts: {
  params: Json;
  respond: Respond;
  client: null;
  context: undefined;
}) => unknown;

/** OpenClaw's gateway `configHandlers`, from the pinned package's dist/. */
async function loadConfigHandlers(): Promise<Record<string, ConfigHandler>> {
  const require = createRequire(import.meta.url);
  // `openclaw/plugin-sdk/config-runtime` is public and lives in dist/plugin-sdk/.
  const dist = dirname(dirname(require.resolve("openclaw/plugin-sdk/config-runtime")));
  const exporting = readdirSync(dist).filter(
    (f) =>
      f.endsWith(".js") &&
      /export \{[^}]*\bconfigHandlers\b[^}]*\}/.test(readFileSync(join(dist, f), "utf-8"))
  );
  expect(exporting, `exactly one chunk in ${dist} must export configHandlers`).toHaveLength(1);
  const mod = (await import(pathToFileURL(join(dist, exporting[0])).href)) as {
    configHandlers: Record<string, ConfigHandler>;
  };
  expect(Object.keys(mod.configHandlers)).toEqual(
    expect.arrayContaining(["config.get", "config.apply"])
  );
  return mod.configHandlers;
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
});
