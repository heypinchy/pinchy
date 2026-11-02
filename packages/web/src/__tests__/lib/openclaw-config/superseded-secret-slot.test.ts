// A superseded versioned key slot must outlive the config apply that moves
// OpenClaw off it (review finding on #1238).
//
// Re-keying an OpenAI-compatible provider writes a NEW slot
// (`providers.<slug>@<newVersion>`) and a config whose SecretRef names it. That
// config reaches OpenClaw through a background `config.apply`, which can take
// 60–100 s under rate limiting or a restart — and until it lands, the config
// OpenClaw is RUNNING still names the old slot. A built-in key rotation inside
// that window fires `secrets.reload`, and OpenClaw re-resolves the running
// config: if the old slot is already gone from secrets.json, the reload fails
// and agents keep presenting the rotated-away built-in key until a restart.
//
// This runs the real regenerate and the real `writeSecretsFile` against an
// in-memory filesystem, with a gateway whose `config.apply` is held open until
// the test lets it land — the only way to reproduce the window.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const enoent = (path: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
      code: "ENOENT",
    });
  const readFileSync = vi.fn((path: string) => {
    const content = files.get(String(path));
    if (content === undefined) throw enoent(String(path));
    return content;
  });
  const writeFileSync = vi.fn((path: string, data: string) => {
    files.set(String(path), String(data));
  });
  const renameSync = vi.fn((from: string, to: string) => {
    const content = files.get(String(from));
    if (content === undefined) throw enoent(String(from));
    files.delete(String(from));
    files.set(String(to), content);
  });
  // Directories are not modelled: report every path as present so no
  // workspace retrofit writes run, exactly like the sibling rotation tests.
  const existsSync = vi.fn(() => true);
  const noop = vi.fn();
  const fsMock = {
    readFileSync,
    writeFileSync,
    renameSync,
    existsSync,
    mkdirSync: noop,
    chmodSync: noop,
  };
  return { ...actual, default: { ...actual, ...fsMock }, ...fsMock };
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

const { settings } = vi.hoisted(() => ({ settings: new Map<string, string>() }));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  getSettingsByPrefix: vi.fn().mockResolvedValue(new Map()),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (val: string) => val,
  encrypt: (val: string) => val,
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

// Stable across regenerates, as they are in production (persisted in the DB).
// With the DB mocked empty they would be minted afresh on every run, and that
// "rotation" would fire a reload of its own.
vi.mock("@/lib/gateway-token-source", () => ({
  getOrCreateGatewayToken: vi.fn(async () => "gw-token-123"),
}));
vi.mock("@/lib/plugin-secrets-source", () => ({
  getOrCreatePluginSecret: vi.fn(async () => "plugin-secret"),
}));

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn(async () => ""),
}));

const { customProviders } = vi.hoisted(() => ({
  customProviders: [] as {
    slug: string;
    displayName: string;
    baseUrl: string;
    models: never[];
    apiKey: string;
    keyVersion: string;
  }[],
}));

vi.mock("@/lib/openai-compatible-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openai-compatible-providers")>()),
  listProvidersWithApiKeys: vi.fn(async () => customProviders.map((p) => ({ ...p }))),
}));

vi.mock("@/lib/openai-compatible-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openai-compatible-discovery")>()),
  resolveCustomProviderModels: vi.fn(async (p: { models: unknown[] }) => p.models),
}));

const { mockGetClient } = vi.hoisted(() => ({ mockGetClient: vi.fn() }));

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { CONFIG_PATH } from "@/lib/openclaw-config/paths";
import { _resetConfigPushState } from "@/lib/openclaw-config/push-state";
import { referencedSecretIds } from "@/lib/openclaw-secrets";

const SECRETS_PATH = process.env.OPENCLAW_SECRETS_PATH || "/openclaw-secrets/secrets.json";

const OLD_VERSION = "0000000000000001";
const NEW_VERSION = "0000000000000002";
const OLD_SLOT = `acme-llm@${OLD_VERSION}`;
const NEW_SLOT = `acme-llm@${NEW_VERSION}`;

function secretsOnDisk(): Record<string, unknown> & {
  providers: Record<string, { apiKey: string }>;
} {
  return JSON.parse(files.get(SECRETS_PATH)!);
}

/** The value a SecretRef id (`/providers/x/apiKey`) resolves to in secrets.json. */
function resolve(id: string): unknown {
  let node: unknown = secretsOnDisk();
  for (const segment of id.split("/").slice(1)) {
    node = (node as Record<string, unknown> | undefined)?.[segment];
  }
  return node;
}

/** The pushes and reloads are fire-and-forget; let their microtasks run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// A gateway whose config.apply stays pending until `land()` — the window in
// which OpenClaw still runs the previous config.
let pendingApplies: { payload: string; resolve: () => void }[];
let reloadOutcomes: { unresolved: string[] }[];

function connectGateway() {
  mockGetClient.mockReturnValue({
    config: {
      // OpenClaw's running config is whatever it last persisted.
      get: vi.fn(async () => ({ hash: "h", config: JSON.parse(files.get(CONFIG_PATH)!) })),
      apply: vi.fn(
        (payload: string) =>
          new Promise<void>((resolve) => {
            pendingApplies.push({ payload, resolve });
          })
      ),
    },
    hasMethod: () => true,
    // secrets.reload re-resolves the config OpenClaw is RUNNING — the one on
    // disk until an apply lands — against secrets.json as it is right now.
    request: vi.fn(async (method: string) => {
      if (method === "secrets.reload") {
        const running = JSON.parse(files.get(CONFIG_PATH)!);
        const unresolved = [...referencedSecretIds(running)].filter(
          (id) => typeof resolve(id) !== "string"
        );
        reloadOutcomes.push({ unresolved });
        return unresolved.length === 0
          ? { type: "res", id: "1", ok: true, payload: {} }
          : { type: "res", id: "1", ok: false, error: { message: "unresolved SecretRef" } };
      }
      return { type: "res", id: "1", ok: true, payload: {} };
    }),
  });
}

/** OpenClaw finishes the newest pending apply and persists that config. */
function land(): void {
  const newest = pendingApplies.at(-1)!;
  files.set(CONFIG_PATH, newest.payload);
  for (const p of pendingApplies) p.resolve();
  pendingApplies = [];
}

describe("a superseded key slot outlives the config apply that moves OpenClaw off it", () => {
  beforeEach(() => {
    files.clear();
    settings.clear();
    customProviders.length = 0;
    pendingApplies = [];
    reloadOutcomes = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    files.set(
      CONFIG_PATH,
      JSON.stringify({ gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } } })
    );
    settings.set("anthropic_api_key", "sk-ant-original");
    customProviders.push({
      slug: "acme-llm",
      displayName: "Acme LLM",
      baseUrl: "https://api.acme.example/v1",
      models: [],
      apiKey: "sk-acme-old",
      keyVersion: OLD_VERSION,
    });
  });

  afterEach(() => {
    for (const p of pendingApplies) p.resolve();
    _resetConfigPushState();
  });

  it("keeps the old slot until the running config moved on, so a built-in rotation's reload resolves", async () => {
    // R0 — baseline. No gateway yet: the config is written straight to disk,
    // so OpenClaw runs the old pointer.
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });
    await regenerateOpenClawConfig();
    await drain();
    expect(referencedSecretIds(JSON.parse(files.get(CONFIG_PATH)!))).toContain(
      `/providers/${OLD_SLOT}/apiKey`
    );

    // R1 — the provider is re-keyed. Its config apply is in flight, not landed.
    connectGateway();
    customProviders[0] = { ...customProviders[0], apiKey: "sk-acme-new", keyVersion: NEW_VERSION };
    await regenerateOpenClawConfig();
    await drain();
    expect(pendingApplies).toHaveLength(1);
    expect(secretsOnDisk().providers[OLD_SLOT]).toEqual({ apiKey: "sk-acme-old" });
    expect(secretsOnDisk().providers[NEW_SLOT]).toEqual({ apiKey: "sk-acme-new" });

    // R2 — the built-in key is rotated while R1's apply is still pending. The
    // reload it fires must find every pointer the RUNNING config holds.
    settings.set("anthropic_api_key", "sk-ant-rotated");
    await regenerateOpenClawConfig();
    await drain();
    expect(reloadOutcomes).toEqual([{ unresolved: [] }]);
    expect(resolve("/providers/anthropic/apiKey")).toBe("sk-ant-rotated");

    // The apply lands: OpenClaw now runs the new pointer. The next regenerate
    // lets the old slot go.
    land();
    await drain();
    await regenerateOpenClawConfig();
    await drain();
    expect(secretsOnDisk().providers[OLD_SLOT]).toBeUndefined();
    expect(secretsOnDisk().providers[NEW_SLOT]).toEqual({ apiKey: "sk-acme-new" });
  });

  it("lets a deleted provider's key go with the first regenerate after OpenClaw dropped its pointer", async () => {
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });
    await regenerateOpenClawConfig();
    await drain();

    // Delete the provider; the apply that removes its pointer is pending.
    connectGateway();
    customProviders.length = 0;
    await regenerateOpenClawConfig();
    await drain();
    expect(secretsOnDisk().providers[OLD_SLOT]).toEqual({ apiKey: "sk-acme-old" });

    land();
    await drain();
    await regenerateOpenClawConfig();
    await drain();
    expect(secretsOnDisk().providers[OLD_SLOT]).toBeUndefined();
  });
});
