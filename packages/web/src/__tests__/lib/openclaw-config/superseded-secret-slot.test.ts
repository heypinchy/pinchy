// A superseded versioned key slot must not outlive its last reference in
// openclaw.json — nor leave secrets.json while openclaw.json still names it
// (review finding on #1238, and #1246).
//
// Re-keying an OpenAI-compatible provider writes a NEW slot
// (`providers.<slug>@<newVersion>`) and a config whose SecretRef names it. That
// config reaches OpenClaw through a background `config.apply`, which can take
// 60–100 s under rate limiting or a restart. If openclaw.json still named the
// old slot after secrets.json lost it, a built-in key rotation inside that
// window would fire `secrets.reload` against a config that no longer resolves
// — the reload fails, and agents keep presenting the rotated-away built-in key
// until a restart — and OpenClaw could not restart on that file at all.
//
// An earlier fix kept the old slot in secrets.json for that window, reading
// the old value back from the file. In production Pinchy cannot read
// secrets.json (fix-config-permissions.sh: root:root 0600 every 50 ms), so it
// kept nothing. Here, as in production, Pinchy cannot read it: openclaw.json is
// rewritten instead, so that after every write of either file each SecretRef
// in it resolves (keyless-bridge.ts).
//
// This runs the real regenerate and the real `writeSecretsFile` against an
// in-memory filesystem, with a gateway whose `config.apply` is held open until
// the test lets it land — the only way to reproduce the window.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { files, afterWrite } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  afterWrite: { check: (_path: string) => {} },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const enoent = (path: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
      code: "ENOENT",
    });
  const secretsPath = process.env.OPENCLAW_SECRETS_PATH || "/openclaw-secrets/secrets.json";
  const readFileSync = vi.fn((path: string) => {
    // Production: root:root 0600, and Pinchy is uid 999.
    if (String(path) === secretsPath) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
        code: "EACCES",
      });
    }
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
    afterWrite.check(String(to));
  });
  // Directories are not modelled: report every path as present so no
  // workspace retrofit writes run, exactly like the sibling rotation tests —
  // except secrets.json, which a host reboot removes (its volume is a tmpfs).
  // Pinchy can see whether it is there: the directory is Pinchy's (0770).
  const existsSync = vi.fn((path: string) =>
    String(path) === secretsPath ? files.has(String(path)) : true
  );
  const unlinkSync = vi.fn((path: string) => {
    if (!files.delete(String(path))) throw enoent(String(path));
  });
  const noop = vi.fn();
  const fsMock = {
    readFileSync,
    writeFileSync,
    renameSync,
    existsSync,
    unlinkSync,
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
    models: unknown[];
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
import {
  _resetConfigPushState,
  getPendingConfigPushCount,
  setLastGoodBound,
} from "@/lib/openclaw-config/push-state";
import { pushConfigInBackground } from "@/lib/openclaw-config/write";
import { LAST_GOOD_BOUND_PATH } from "@/lib/openclaw-config/last-good-bound";
import { keylessBridge } from "@/lib/openclaw-config/keyless-bridge";
import { referencedSecretIds, type SecretsBundle } from "@/lib/openclaw-secrets";
import { endPinchyProcess } from "@/test-helpers/pinchy-restart";

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

/** Every pinchy SecretRef in openclaw.json that secrets.json cannot resolve right now. */
function danglingOnDisk(): string[] {
  const onDisk = files.get(CONFIG_PATH);
  if (onDisk === undefined || !files.has(SECRETS_PATH)) return [];
  return [...referencedSecretIds(JSON.parse(onDisk))].filter(
    (id) => typeof resolve(id) !== "string"
  );
}

/** The pushes and reloads are fire-and-forget; let their microtasks run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// A gateway whose config.apply stays pending until `land()` — the window in
// which OpenClaw still runs the previous config.
let pendingApplies: { payload: string; resolve: () => void }[];
let reloadOutcomes: { unresolved: string[] }[];
/** openclaw.json after every write of either file, with what it named that did not resolve. */
let writes: { path: string; config: string; dangling: string[] }[];

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
  const newest = pendingApplies.at(-1);
  if (newest) files.set(CONFIG_PATH, newest.payload);
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
    writes = [];
    afterWrite.check = (path) => {
      if (path !== CONFIG_PATH && path !== SECRETS_PATH) return;
      writes.push({ path, config: files.get(CONFIG_PATH) ?? "", dangling: danglingOnDisk() });
    };
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
    afterWrite.check = () => {};
    _resetConfigPushState();
  });

  it("re-points openclaw.json at the new slot as the old one leaves, so a built-in rotation's reload resolves", async () => {
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

    // R1 — the provider is re-keyed. Any config apply it needs stays in flight.
    connectGateway();
    writes = [];
    customProviders[0] = { ...customProviders[0], apiKey: "sk-acme-new", keyVersion: NEW_VERSION };
    await regenerateOpenClawConfig();
    await drain();
    // The old slot is gone at once — nothing keeps it — and openclaw.json never
    // named a slot secrets.json lacked, after any write of either file.
    expect(secretsOnDisk().providers[OLD_SLOT]).toBeUndefined();
    expect(secretsOnDisk().providers[NEW_SLOT]).toEqual({ apiKey: "sk-acme-new" });
    expect(writes.map((w) => w.path)).toEqual([CONFIG_PATH, SECRETS_PATH, CONFIG_PATH]);
    expect(writes.flatMap((w) => w.dangling)).toEqual([]);
    expect(referencedSecretIds(JSON.parse(files.get(CONFIG_PATH)!))).toContain(
      `/providers/${NEW_SLOT}/apiKey`
    );

    // R2 — the built-in key is rotated while nothing of R1 has been applied.
    // The reload it fires must find every pointer the RUNNING config holds.
    settings.set("anthropic_api_key", "sk-ant-rotated");
    await regenerateOpenClawConfig();
    await drain();
    expect(reloadOutcomes).toEqual([{ unresolved: [] }]);
    expect(resolve("/providers/anthropic/apiKey")).toBe("sk-ant-rotated");

    // The apply lands: nothing left to let go of.
    land();
    await drain();
    await regenerateOpenClawConfig();
    await drain();
    expect(secretsOnDisk().providers[OLD_SLOT]).toBeUndefined();
    expect(secretsOnDisk().providers[NEW_SLOT]).toEqual({ apiKey: "sk-acme-new" });
    expect(writes.flatMap((w) => w.dangling)).toEqual([]);
  });

  it("lets a deleted provider's key go with the deletion's own regenerate, after openclaw.json stopped naming it", async () => {
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });
    await regenerateOpenClawConfig();
    await drain();

    // Delete the provider; the apply that removes it is pending.
    connectGateway();
    writes = [];
    customProviders.length = 0;
    await regenerateOpenClawConfig();
    await drain();
    expect(secretsOnDisk().providers[OLD_SLOT]).toBeUndefined();
    expect(writes.map((w) => w.path)).toEqual([CONFIG_PATH, SECRETS_PATH]);
    expect(writes.flatMap((w) => w.dangling)).toEqual([]);
    // Until the apply lands, the provider stays listed — without a key.
    const onDisk = JSON.parse(files.get(CONFIG_PATH)!);
    expect(onDisk.models.providers["acme-llm"]).toBeDefined();
    expect(onDisk.models.providers["acme-llm"]).not.toHaveProperty("apiKey");

    land();
    await drain();
    await regenerateOpenClawConfig();
    await drain();
    expect(secretsOnDisk().providers[OLD_SLOT]).toBeUndefined();
    expect(writes.flatMap((w) => w.dangling)).toEqual([]);
  });

  // #1238: a key entered for one address must never go to another. The
  // re-pointed openclaw.json Pinchy writes while the apply is pending is read by
  // OpenClaw (hot reload, restart), so it must pair the new slot with the new
  // base URL — never with the address still on disk.
  it("never pairs the new slot with the old base URL in any file it writes", async () => {
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });
    await regenerateOpenClawConfig();
    await drain();

    connectGateway();
    writes = [];
    customProviders[0] = {
      ...customProviders[0],
      baseUrl: "https://new-gateway.example/v1",
      apiKey: "sk-acme-new",
      keyVersion: NEW_VERSION,
    };
    await regenerateOpenClawConfig();
    await drain();

    expect(writes.length).toBeGreaterThan(0);
    const sent = pendingApplies.map((p) => ({ config: p.payload }));
    for (const { config } of [...writes, ...sent]) {
      const acme = JSON.parse(config).models.providers["acme-llm"];
      if (JSON.stringify(acme).includes(NEW_SLOT)) {
        expect(acme.baseUrl).toBe("https://new-gateway.example/v1");
      }
      if (JSON.stringify(acme).includes(OLD_SLOT)) {
        expect(acme.baseUrl).toBe("https://api.acme.example/v1");
      }
    }
    expect(writes.flatMap((w) => w.dangling)).toEqual([]);
  });
  // A re-key to an address that serves a much smaller catalogue: the payload
  // shrinks a KEPT provider, so the #311 guard refuses it, as it refuses any
  // kept provider's catalogue shrink under half the file. The refusal still
  // takes the old slot out of secrets.json, so it still writes the bridge and
  // the re-keyed entry — and each of those file writes must stay above
  // OpenClaw's read-side check (under half of last-known-good, it restores
  // `.bak`, which names the old slot). The real handlers judge the same files
  // in integration/openclaw-config-size-drop-against-oc.test.ts.
  describe("re-keyed to a much smaller catalogue (refused by the #311 guard)", () => {
    const bigCatalogue = Array.from({ length: 40 }, (_, i) => ({
      id: `acme-model-${i}-with-a-realistically-long-identifier`,
      name: `Acme Model ${i} (realistic display name)`,
      contextWindow: 128000,
      maxTokens: 8192,
      input: ["text"],
    }));
    const rekeyToSmallEndpoint = () => {
      customProviders[0] = {
        ...customProviders[0],
        baseUrl: "https://small.example/v1",
        models: [{ id: "small-model", name: "Small Model", input: ["text"] }],
        apiKey: "sk-acme-new",
        keyVersion: NEW_VERSION,
      };
    };
    /** Boot with no gateway, so the big catalogue is on disk as OpenClaw's file. */
    async function installWithBigCatalogue(): Promise<string> {
      customProviders[0] = { ...customProviders[0], models: bigCatalogue };
      mockGetClient.mockImplementation(() => {
        throw new Error("OpenClaw client not initialized");
      });
      await regenerateOpenClawConfig();
      await drain();
      return files.get(CONFIG_PATH)!;
    }

    it("never file-writes a config under OpenClaw's read-side check, and resolves after every write", async () => {
      const installed = await installWithBigCatalogue();
      connectGateway();
      writes = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      rekeyToSmallEndpoint();
      await regenerateOpenClawConfig();
      await drain();

      expect(errorSpy.mock.calls.flat().join(" "), "precondition: refused").toMatch(
        /suspiciously small/
      );
      expect(writes.map((w) => w.path)).toEqual([CONFIG_PATH, SECRETS_PATH, CONFIG_PATH]);
      expect(writes.flatMap((w) => w.dangling)).toEqual([]);
      for (const w of writes.filter((w) => w.path === CONFIG_PATH)) {
        expect(
          Buffer.byteLength(w.config),
          "over half of the file OpenClaw last accepted, with headroom"
        ).toBeGreaterThan(Buffer.byteLength(installed) * 0.55);
      }
      const acme = JSON.parse(files.get(CONFIG_PATH)!).models.providers["acme-llm"];
      expect(acme.apiKey.id).toBe(`/providers/${NEW_SLOT}/apiKey`);
      expect(acme.baseUrl).toBe("https://small.example/v1");
      expect(acme.models.map((m: { id: string }) => m.id)).toContain("small-model");
      expect(pendingApplies, "a refused regenerate pushes nothing").toEqual([]);

      // The known limit, pinned: the smaller catalogue is a kept provider's
      // shrink, which the #311 guard refuses on every later regenerate too
      // (as on main). Each refusal leaves a file OpenClaw starts on.
      const settled = files.get(CONFIG_PATH);
      writes = [];
      errorSpy.mockClear();
      await regenerateOpenClawConfig();
      await drain();
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/suspiciously small/);
      expect(writes.map((w) => w.path)).toEqual([SECRETS_PATH]);
      expect(writes.flatMap((w) => w.dangling)).toEqual([]);
      expect(files.get(CONFIG_PATH)).toBe(settled);
    });

    // A catalogue the guard refuses (under half of the file), but not by much.
    // The re-keyed entry then carries only as many of the file's models as
    // keep the file above OpenClaw's read-side line — not all of them — so the
    // file sits just above that line, and the next regenerate's guard, judging
    // the same target against it, lets it through. Carrying every model left
    // the file as large as before, and refused this target forever.
    it("delivers a catalogue the guard refused this time with the next regenerate, when it is over half of the re-keyed file", async () => {
      await installWithBigCatalogue();
      connectGateway();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const smaller = Array.from({ length: 8 }, (_, i) => ({
        ...bigCatalogue[i],
        id: `small-model-${i}-with-a-realistically-long-identifier`,
      }));
      customProviders[0] = {
        ...customProviders[0],
        baseUrl: "https://small.example/v1",
        models: smaller,
        apiKey: "sk-acme-new",
        keyVersion: NEW_VERSION,
      };
      await regenerateOpenClawConfig();
      await drain();
      expect(errorSpy.mock.calls.flat().join(" "), "precondition: refused").toMatch(
        /suspiciously small/
      );
      expect(pendingApplies).toEqual([]);

      errorSpy.mockClear();
      await regenerateOpenClawConfig();
      await drain();
      expect(errorSpy.mock.calls.flat().join(" ")).not.toMatch(/suspiciously small/);
      expect(pendingApplies).toHaveLength(1);
      land();
      await drain();
      const acme = JSON.parse(files.get(CONFIG_PATH)!).models.providers["acme-llm"];
      expect(acme.models.map((m: { id: string }) => m.id)).toEqual(smaller.map((m) => m.id));
      expect(acme.apiKey.id).toBe(`/providers/${NEW_SLOT}/apiKey`);
      expect(acme.baseUrl).toBe("https://small.example/v1");
    });

    // OpenClaw promotes last-known-good only while it runs. With it down, every
    // Pinchy write lands on the file from before the FIRST of them, and the
    // re-keyed file sits just above half of that one: judged only against the
    // re-keyed file on disk, the next regenerate wrote its target (a quarter of
    // last-known-good), and a second re-key a re-keyed file as small. OpenClaw's
    // next start restored `.bak` over either — the old slot, gone from
    // secrets.json. A Pinchy restart in between loses nothing Pinchy needs to
    // know. The real handlers judge the same sequences in
    // integration/openclaw-config-size-drop-against-oc.test.ts.
    it("never file-writes under half of OpenClaw's last-known-good while it is down, across a restart and a second re-key", async () => {
      const installed = await installWithBigCatalogue();
      const line = Math.floor(Buffer.byteLength(installed) * 0.5);
      writes = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const smaller = (prefix: string) =>
        Array.from({ length: 8 }, (_, i) => ({
          ...bigCatalogue[i],
          id: `${prefix}-model-${i}-with-a-realistically-long-identifier`,
        }));
      const rekey = (version: string, prefix: string) => {
        customProviders[0] = {
          ...customProviders[0],
          baseUrl: `https://${prefix}.example/v1`,
          models: smaller(prefix),
          apiKey: `sk-acme-${version}`,
          keyVersion: version,
        };
      };
      /** Pinchy restarts: fresh modules and process state; the disk survives. */
      const restartPinchy = async () => {
        vi.resetModules();
        endPinchyProcess();
        return (await import("@/lib/openclaw-config")).regenerateOpenClawConfig;
      };

      rekey(NEW_VERSION, "small");
      await regenerateOpenClawConfig();
      await drain();
      expect(errorSpy.mock.calls.flat().join(" "), "precondition: refused").toMatch(
        /suspiciously small/
      );
      let regenerate = await restartPinchy();
      await regenerate();
      await drain();
      rekey("0000000000000003", "smaller");
      regenerate = await restartPinchy();
      await regenerate();
      await drain();
      await regenerate();
      await drain();

      const configWrites = writes.filter((w) => w.path === CONFIG_PATH);
      expect(configWrites.length, "precondition: the re-keys wrote the file").toBeGreaterThan(2);
      for (const w of configWrites) {
        expect(
          Buffer.byteLength(w.config),
          "at or above OpenClaw's read-side line"
        ).toBeGreaterThanOrEqual(line);
      }
      expect(writes.flatMap((w) => w.dangling)).toEqual([]);
      const acme = JSON.parse(files.get(CONFIG_PATH)!).models.providers["acme-llm"];
      expect(acme.apiKey.id).toBe("/providers/acme-llm@0000000000000003/apiKey");
      expect(acme.baseUrl).toBe("https://smaller.example/v1");
    });

    // A push started before the refusal still carries the old slot. When it
    // wakes, OpenClaw refuses its payload (the slot no longer resolves), and
    // once its retries ran out its file fallback wrote that payload: a file
    // naming a key secrets.json had already lost. The refusal supersedes it.
    it("supersedes a push still in flight, so it never retries or file-writes the old slot", async () => {
      await installWithBigCatalogue();
      const applies: string[] = [];
      const inFlight: { reject: (err: Error) => void }[] = [];
      mockGetClient.mockReturnValue({
        config: {
          get: vi.fn(async () => ({ hash: "h", config: JSON.parse(files.get(CONFIG_PATH)!) })),
          apply: vi.fn((payload: string) => {
            applies.push(payload);
            return new Promise<void>((_, reject) => inFlight.push({ reject }));
          }),
        },
        hasMethod: () => true,
        request: vi.fn(async () => ({ type: "res", id: "1", ok: true, payload: {} })),
      });
      // An earlier change (one more model) whose apply is still in flight.
      customProviders[0] = {
        ...customProviders[0],
        models: [...bigCatalogue, { ...bigCatalogue[0], id: "acme-model-extra" }],
      };
      await regenerateOpenClawConfig();
      await drain();
      expect(applies, "precondition: its apply is in flight").toHaveLength(1);
      expect(applies[0]).toContain(OLD_SLOT);

      vi.spyOn(console, "error").mockImplementation(() => {});
      rekeyToSmallEndpoint();
      await regenerateOpenClawConfig();
      await drain();
      const afterRefusal = files.get(CONFIG_PATH)!;
      expect(afterRefusal).not.toContain(OLD_SLOT);

      inFlight[0].reject(
        new Error(
          `invalid config: active SecretRef resolution failed for models.providers.acme-llm.apiKey`
        )
      );
      for (let i = 0; i < 1200 && getPendingConfigPushCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(getPendingConfigPushCount()).toBe(0);
      expect(applies, "superseded: no retry of the old payload").toHaveLength(1);
      expect(files.get(CONFIG_PATH)).toBe(afterRefusal);
    });

    // Only a refusal that took a key out of secrets.json has anything to
    // supersede: a push from before it can name that key. The common refusal
    // removes no key — Ollama unreachable at boot, a discovery that answered
    // half — and superseding then just dropped whatever was in flight: a
    // Telegram disconnect parked in OpenClaw's rate-limit wait (the bot kept
    // polling with the revoked token), a permission revocation.
    it("leaves a push in flight intact when the refusal removed no key", async () => {
      await installWithBigCatalogue();
      const applies: string[] = [];
      let first: { reject: (err: Error) => void } | undefined;
      mockGetClient.mockReturnValue({
        config: {
          get: vi.fn(async () => ({ hash: "h", config: JSON.parse(files.get(CONFIG_PATH)!) })),
          apply: vi.fn((payload: string) => {
            applies.push(payload);
            if (first) return Promise.resolve();
            return new Promise<void>((_, reject) => (first = { reject }));
          }),
        },
        hasMethod: () => true,
        request: vi.fn(async () => ({ type: "res", id: "1", ok: true, payload: {} })),
      });
      // A targeted writer's change, its apply in flight.
      const onDisk = JSON.parse(files.get(CONFIG_PATH)!);
      const targeted = JSON.stringify({ ...onDisk, channels: { telegram: { enabled: false } } });
      pushConfigInBackground(targeted);
      await drain();
      expect(applies, "precondition: its apply is in flight").toHaveLength(1);

      // Discovery answers a fraction of the same provider's catalogue: same
      // key, so nothing leaves secrets.json — and the guard refuses.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      customProviders[0] = { ...customProviders[0], models: bigCatalogue.slice(0, 2) };
      writes = [];
      await regenerateOpenClawConfig();
      await drain();
      expect(errorSpy.mock.calls.flat().join(" "), "precondition: refused").toMatch(
        /suspiciously small/
      );
      expect(
        writes.map((w) => w.path),
        "precondition: no bridge"
      ).toEqual([SECRETS_PATH]);

      first!.reject(new Error("config changed since last load; re-run config.get and retry"));
      for (let i = 0; i < 1200 && getPendingConfigPushCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(getPendingConfigPushCount()).toBe(0);
      expect(applies, "not superseded: the change is retried and lands").toHaveLength(2);
      expect(JSON.parse(applies[1]).channels).toEqual({ telegram: { enabled: false } });
    });
  });

  // The file fallback is the one route by which a push writes openclaw.json
  // itself. A payload captured before a key left secrets.json — a targeted
  // writer's copy of the pre-bridge file, or an older regenerate's — is one
  // OpenClaw refuses over config.apply (its SecretRef does not resolve), so
  // every retry fails and the fallback used to write it: a file OpenClaw can
  // neither start on nor accept a copy of. The fallback now checks the payload
  // against the bundle Pinchy last wrote, kept in memory without its values —
  // never by reading secrets.json.
  describe("the push's file fallback", () => {
    async function deleteAcme(): Promise<string> {
      mockGetClient.mockImplementation(() => {
        throw new Error("OpenClaw client not initialized");
      });
      await regenerateOpenClawConfig();
      await drain();
      const preDeletion = files.get(CONFIG_PATH)!;
      expect(preDeletion).toContain(OLD_SLOT);
      customProviders.length = 0;
      await regenerateOpenClawConfig();
      await drain();
      expect(secretsOnDisk().providers[OLD_SLOT], "precondition: the key left").toBeUndefined();
      return preDeletion;
    }

    it("never writes a payload naming a key secrets.json no longer holds once config.apply gives up", async () => {
      const stale = await deleteAcme();
      const afterDeletion = files.get(CONFIG_PATH)!;
      const applies: string[] = [];
      mockGetClient.mockReturnValue({
        config: {
          get: vi.fn(async () => ({ hash: "h", config: JSON.parse(files.get(CONFIG_PATH)!) })),
          apply: vi.fn(async (payload: string) => {
            applies.push(payload);
            throw new Error(
              "invalid config: active SecretRef resolution failed for models.providers.acme-llm.apiKey"
            );
          }),
        },
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      pushConfigInBackground(stale);
      for (let i = 0; i < 2000 && getPendingConfigPushCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }

      expect(getPendingConfigPushCount()).toBe(0);
      expect(applies.length, "precondition: config.apply was tried").toBeGreaterThan(0);
      expect(files.get(CONFIG_PATH)).toBe(afterDeletion);
      expect(errorSpy.mock.calls.flat().join(" ")).toContain(`/providers/${OLD_SLOT}/apiKey`);
    }, 20_000);

    it("never writes such a payload without an OpenClaw client either", async () => {
      const stale = await deleteAcme();
      const afterDeletion = files.get(CONFIG_PATH)!;
      vi.spyOn(console, "error").mockImplementation(() => {});

      pushConfigInBackground(stale);
      await drain();

      expect(files.get(CONFIG_PATH)).toBe(afterDeletion);
    });

    it("still writes a payload whose every key resolves", async () => {
      const stale = await deleteAcme();
      // The stale file without the deleted provider, serialized as Pinchy
      // writes the file: a payload far under half of it is a write OpenClaw's
      // read side reverts, refused for that (last-good-bound.ts).
      const file = JSON.parse(stale);
      delete file.models.providers["acme-llm"];
      const resolvable = JSON.stringify(
        { ...file, agents: { ...file.agents, list: [{ id: "smithers", name: "S" }] } },
        null,
        2
      );

      pushConfigInBackground(resolvable);
      await drain();

      expect(files.get(CONFIG_PATH)).toBe(resolvable);
    });
  });
  // The last-known-good bound (last-good-bound.ts) only ever errs high, and it
  // goes stale whenever OpenClaw promotes a file Pinchy wrote without a
  // config.apply landing since — a push's file fallback written while OpenClaw
  // was unreachable, which it then started on. A stale bound refuses a file
  // write OpenClaw would have accepted. For the bridge and the re-keyed entry
  // that used to throw out of the regenerate: before secrets.json, before any
  // push, and the same way on every later regenerate, so no config change
  // reached OpenClaw again — across restarts, since the bound is persisted.
  // A refused write goes over config.apply instead, whose landing clears the
  // bound, and the regenerate carries on from there.
  describe("a last-known-good bound OpenClaw has moved past", () => {
    /** Pinchy still assumes OpenClaw may hold a file of `bytes`; it runs the one on disk. */
    function staleBound(bytes: number) {
      files.set(LAST_GOOD_BOUND_PATH, JSON.stringify({ bytes }) + "\n");
      setLastGoodBound({ bytes, persistedBytes: bytes });
    }
    /** A secrets.json shape resolving every pointer in `config` but `except`. */
    function bundleResolving(config: string, except: string): SecretsBundle {
      const bundle: Record<string, unknown> = {};
      for (const id of referencedSecretIds(JSON.parse(config))) {
        if (id === except) continue;
        const segments = id.split("/").slice(1);
        let node = bundle;
        for (const segment of segments.slice(0, -1)) {
          node = (node[segment] ??= {}) as Record<string, unknown>;
        }
        node[segments.at(-1)!] = "x";
      }
      return bundle as SecretsBundle;
    }
    const bytes = (s: string) => Buffer.byteLength(s, "utf-8");
    const serialize = (c: unknown) => JSON.stringify(c, null, 2).trimEnd() + "\n";
    async function waitFor(condition: () => boolean, what: string) {
      for (let i = 0; i < 1000 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(condition(), what).toBe(true);
    }
    async function install(): Promise<string> {
      mockGetClient.mockImplementation(() => {
        throw new Error("OpenClaw client not initialized");
      });
      await regenerateOpenClawConfig();
      await drain();
      return files.get(CONFIG_PATH)!;
    }

    it("sends a deletion's key-less bridge over config.apply when the file write is refused, and finishes once it lands", async () => {
      const installed = await install();
      // The file on disk sits one byte above the line; the bridge, which only
      // drops the key reference, falls under it.
      staleBound(2 * bytes(installed) - 1);
      connectGateway();
      writes = [];
      vi.spyOn(console, "error").mockImplementation(() => {});

      customProviders.length = 0;
      await expect(regenerateOpenClawConfig()).resolves.toBeUndefined();
      await drain();

      // Nothing written: openclaw.json still names the key, so secrets.json keeps it.
      expect(writes).toEqual([]);
      expect(secretsOnDisk().providers[OLD_SLOT]).toBeDefined();
      expect(pendingApplies, "the bridge goes over config.apply instead").toHaveLength(1);
      const sent = JSON.parse(pendingApplies[0].payload).models.providers["acme-llm"];
      expect(sent).toBeDefined();
      expect(sent).not.toHaveProperty("apiKey");

      // It lands: OpenClaw runs (and persisted) the bridge, and the bound is gone.
      land();
      await waitFor(
        () => pendingApplies.length === 1 && secretsOnDisk().providers[OLD_SLOT] === undefined,
        "the regenerate carries on: secrets.json without the key, then the deletion"
      );
      expect(files.has(LAST_GOOD_BOUND_PATH)).toBe(false);
      land();
      await drain();
      expect(JSON.parse(files.get(CONFIG_PATH)!).models.providers).not.toHaveProperty("acme-llm");
      expect(writes.flatMap((w) => w.dangling)).toEqual([]);
    });

    // A host reboot empties the secrets tmpfs, and OpenClaw starts only once
    // Pinchy is healthy, so Pinchy's boot regenerate runs with OpenClaw down.
    // When the file still names a deleted provider's key and the bridge falls
    // under a persisted bound, the bridge waits for config.apply — and
    // secrets.json used to wait with it. OpenClaw could then start on nothing:
    // every SecretRef in the file, the kept providers' too, was unresolvable,
    // so it never came up, never connected, and the deferred bridge never
    // landed. The file on disk must resolve against secrets.json whatever
    // waits for OpenClaw.
    it("writes a secrets.json the file on disk resolves against after a host reboot, while the bridge waits for OpenClaw", async () => {
      const installed = await install();
      staleBound(2 * bytes(installed) - 1);
      customProviders.length = 0;
      // The reboot: secrets.json is gone, Pinchy starts afresh, OpenClaw is down.
      files.delete(SECRETS_PATH);
      _resetConfigPushState();
      writes = [];
      vi.spyOn(console, "error").mockImplementation(() => {});

      await regenerateOpenClawConfig();
      await drain();

      expect(files.get(CONFIG_PATH), "the bridge waits for config.apply").toBe(installed);
      expect(files.has(SECRETS_PATH), "secrets.json is written").toBe(true);
      expect(danglingOnDisk(), "every SecretRef in openclaw.json resolves").toEqual([]);
      expect(resolve("/providers/anthropic/apiKey"), "kept keys are the real ones").toBe(
        "sk-ant-original"
      );
      expect(resolve(`/providers/${OLD_SLOT}/apiKey`)).not.toBe("sk-acme-old");

      // OpenClaw starts on it and connects; the regenerate that connect runs
      // delivers the bridge, then the deletion.
      connectGateway();
      await regenerateOpenClawConfig();
      await drain();
      expect(pendingApplies, "the bridge goes over config.apply").toHaveLength(1);
      land();
      await waitFor(
        () => pendingApplies.length === 1 && secretsOnDisk().providers[OLD_SLOT] === undefined,
        "secrets.json without the removed key once the bridge landed, then the deletion"
      );
      land();
      await drain();
      expect(JSON.parse(files.get(CONFIG_PATH)!).models.providers).not.toHaveProperty("acme-llm");
      expect(writes.flatMap((w) => w.dangling)).toEqual([]);
    });

    it("sends the re-keyed entry over config.apply when its file write is refused, and lands the re-key", async () => {
      // An address long enough that the re-keyed entry, pointing at a short
      // one, is smaller than the bridge that keeps the long one.
      customProviders[0] = {
        ...customProviders[0],
        baseUrl: `https://api.acme.example/${"v".repeat(400)}/v1`,
      };
      const installed = await install();
      const bridgeBytes = bytes(
        serialize(
          keylessBridge(
            JSON.parse(installed),
            bundleResolving(installed, `/providers/${OLD_SLOT}/apiKey`)
          )
        )
      );
      // The bridge sits exactly on the line; the re-keyed file falls under it.
      staleBound(2 * bridgeBytes);
      connectGateway();
      writes = [];
      vi.spyOn(console, "error").mockImplementation(() => {});

      customProviders[0] = {
        ...customProviders[0],
        baseUrl: "https://s.example/v1",
        apiKey: "sk-acme-new",
        keyVersion: NEW_VERSION,
      };
      await expect(regenerateOpenClawConfig()).resolves.toBeUndefined();
      await drain();

      expect(
        writes.map((w) => w.path),
        "bridge, secrets.json — and no re-keyed file"
      ).toEqual([CONFIG_PATH, SECRETS_PATH]);
      expect(writes.flatMap((w) => w.dangling)).toEqual([]);
      expect(pendingApplies, "the re-keyed entry goes over config.apply instead").toHaveLength(1);
      const sent = JSON.parse(pendingApplies[0].payload).models.providers["acme-llm"];
      expect(sent.apiKey.id).toBe(`/providers/${NEW_SLOT}/apiKey`);
      expect(sent.baseUrl).toBe("https://s.example/v1");

      land();
      await waitFor(
        () => writes.filter((w) => w.path === SECRETS_PATH).length === 2,
        "the regenerate carries on once it landed"
      );
      for (let i = 0; i < 200 && getPendingConfigPushCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      land();
      await drain();
      const acme = JSON.parse(files.get(CONFIG_PATH)!).models.providers["acme-llm"];
      expect(acme.apiKey.id).toBe(`/providers/${NEW_SLOT}/apiKey`);
      expect(acme.baseUrl).toBe("https://s.example/v1");
      expect(files.has(LAST_GOOD_BOUND_PATH)).toBe(false);
      expect(writes.flatMap((w) => w.dangling)).toEqual([]);
    });
  });

  // A provider read that comes back empty is refused by the #311 guard, and
  // writes no secrets.json: it would drop every key the file still names. But
  // after a host reboot there is no secrets.json to keep keys in, and OpenClaw,
  // started only once Pinchy is healthy, could not resolve a single SecretRef
  // in the file — it never came up, so no connect ever ran the regenerate that
  // reads the providers again.
  it("leaves a secrets.json the file on disk resolves against when an empty provider read follows a host reboot", async () => {
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });
    await regenerateOpenClawConfig();
    await drain();
    const installed = files.get(CONFIG_PATH)!;
    files.delete(SECRETS_PATH);
    _resetConfigPushState();
    settings.delete("anthropic_api_key");
    customProviders.length = 0;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await regenerateOpenClawConfig();
    await drain();

    expect(errorSpy.mock.calls.flat().join(" "), "precondition: refused").toMatch(
      /suspiciously small/
    );
    expect(files.get(CONFIG_PATH)).toBe(installed);
    expect(files.has(SECRETS_PATH), "secrets.json is written").toBe(true);
    expect(danglingOnDisk(), "every SecretRef in openclaw.json resolves").toEqual([]);
  });

  // A small provider deletion — not one OpenClaw refuses as a size drop — can
  // be superseded by a targeted writer (a Telegram bot connected meanwhile)
  // before its config.apply goes out. The targeted writer pushes its copy of
  // the file, which still lists the deleted provider as a key-less stub; with
  // no follow-up, OpenClaw kept that stub until the next config change.
  it("finishes a small provider deletion a targeted write superseded before it reached OpenClaw", async () => {
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });
    await regenerateOpenClawConfig();
    await drain();

    let releaseGet!: () => void;
    const firstGetHeld = new Promise<void>((resolve) => (releaseGet = resolve));
    let gets = 0;
    mockGetClient.mockReturnValue({
      config: {
        get: vi.fn(async () => {
          if (gets++ === 0) await firstGetHeld;
          return { hash: "h", config: JSON.parse(files.get(CONFIG_PATH)!) };
        }),
        apply: vi.fn(async (payload: string) => {
          files.set(CONFIG_PATH, payload);
        }),
      },
      hasMethod: () => true,
      request: vi.fn(async () => ({ type: "res", id: "1", ok: true, payload: {} })),
    });

    customProviders.length = 0;
    await regenerateOpenClawConfig();
    await drain();
    const onDisk = JSON.parse(files.get(CONFIG_PATH)!);
    expect(onDisk.models.providers, "precondition: the stub").toHaveProperty("acme-llm");
    pushConfigInBackground(
      JSON.stringify({ ...onDisk, channels: { telegram: { enabled: false } } }, null, 2)
    );
    releaseGet();

    // The deletion's own push hands off to the follow-up regenerate.
    const warn = vi.mocked(console.warn);
    for (let i = 0; i < 400 && !warn.mock.calls.flat().join(" ").includes("superseded"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(warn.mock.calls.flat().join(" ")).toMatch(
      /provider deletion stopped after 0 step\(s\) \(superseded before it finished\); queueing a follow-up regenerate/
    );
    for (
      let i = 0;
      i < 1600 && "acme-llm" in JSON.parse(files.get(CONFIG_PATH)!).models.providers;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(JSON.parse(files.get(CONFIG_PATH)!).models.providers).not.toHaveProperty("acme-llm");
  }, 20_000);
});
