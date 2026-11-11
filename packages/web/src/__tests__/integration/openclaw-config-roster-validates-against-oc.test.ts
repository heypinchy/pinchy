/**
 * The config Pinchy emits for a real fleet — several agents, Telegram bots,
 * a personal agent with per-user peer bindings — must load under the pinned
 * OpenClaw's own strict loader, starting from an `openclaw.json` an earlier
 * Pinchy wrote.
 *
 * OpenClaw 2026.8/9 moved a set of keys (`agents.list` → keyed
 * `agents.entries`, `agents.defaults.memorySearch` → `memory.search`, root
 * `canvasHost` → the `canvas` plugin entry, root `media.ttlHours` →
 * `attachments.ttlHours`, binding peer kind `dm` → `direct`) and dropped
 * `agents.defaults.contextTokens`. Its loader rejects every one of the old
 * keys; only `openclaw doctor` migrates them, and nothing in a Pinchy
 * deployment runs doctor. A key Pinchy kept emitting — or kept carrying
 * through from the file it read — leaves OpenClaw on an invalid config after
 * the first regenerate.
 *
 * The zero-agent case lives in openclaw-config-validates-against-oc.test.ts;
 * this one needs rows, so its db mock answers per table.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { rowsByTable } = vi.hoisted(() => ({ rowsByTable: new Map<unknown, unknown[]>() }));

vi.mock("@/db", () => {
  const rowsFor = (table: unknown) => rowsByTable.get(table) ?? [];
  const query = (table: unknown) =>
    Object.assign(Promise.resolve(rowsFor(table)), {
      innerJoin: () => Object.assign(Promise.resolve([]), { where: async () => [] as unknown[] }),
      where: async () => rowsFor(table),
    });
  return { db: { select: () => ({ from: (table: unknown) => query(table) }) } };
});

const { settings } = vi.hoisted(() => ({ settings: new Map<string, string>() }));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  getSettingsByPrefix: vi.fn(
    async (prefix: string) => new Map([...settings].filter(([k]) => k.startsWith(prefix)))
  ),
  getSettingsByKeys: vi.fn(async () => new Map<string, string>()),
  setSetting: vi.fn(async () => undefined),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (val: string) => val,
  encrypt: (val: string) => val,
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

vi.mock("@/lib/provider-models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provider-models")>()),
  getDefaultModel: vi.fn().mockResolvedValue("anthropic/claude-haiku-4-5-20251001"),
}));

const MODEL = "anthropic/claude-haiku-4-5-20251001";

function agentRow(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    model: MODEL,
    pluginConfig: null,
    allowedTools: ["pinchy_memory"],
    skills: [],
    ownerId: null,
    isPersonal: false,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...extra,
  };
}

type Json = Record<string, unknown>;

/**
 * OpenClaw's strict loader, reading the file on every call. `loadConfig`
 * answers from a process-wide snapshot once one is loaded, so without the
 * clear every test after the first would be judged against an earlier
 * test's file.
 */
async function freshOpenClawLoader(): Promise<() => unknown> {
  const runtime = (await import("openclaw/plugin-sdk/config-runtime")) as unknown as {
    loadConfig: () => unknown;
    clearRuntimeConfigSnapshot: () => void;
  };
  return () => {
    runtime.clearRuntimeConfigSnapshot();
    return runtime.loadConfig();
  };
}

describe("openclaw.json for a multi-agent fleet validates under OpenClaw's own loader", () => {
  let tmpConfigDir: string;
  let tmpSecretsDir: string;
  let tmpWorkspaces: string;

  beforeEach(async () => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), "pinchy-config-"));
    tmpSecretsDir = mkdtempSync(join(tmpdir(), "pinchy-secrets-"));
    tmpWorkspaces = mkdtempSync(join(tmpdir(), "pinchy-ws-"));
    process.env.OPENCLAW_CONFIG_PATH = join(tmpConfigDir, "openclaw.json");
    process.env.OPENCLAW_SECRETS_PATH = join(tmpSecretsDir, "secrets.json");
    process.env.OPENCLAW_SECRETS_PATH_IN_OPENCLAW = join(tmpSecretsDir, "secrets.json");
    process.env.WORKSPACE_BASE_PATH = tmpWorkspaces;
    delete process.env.ANTHROPIC_BASE_URL;
    vi.resetModules();

    const schema = await import("@/db/schema");
    rowsByTable.clear();
    rowsByTable.set(schema.agents, [
      agentRow("smithers-u1", "Smithers", { isPersonal: true, ownerId: "u1" }),
      agentRow("kb-agent", "Handbook"),
      agentRow("odoo-agent", "Odoo"),
    ]);
    rowsByTable.set(schema.users, [{ id: "u1", role: "admin" }]);
    rowsByTable.set(schema.channelLinks, [
      { userId: "u1", channel: "telegram", channelUserId: "111222333" },
    ]);
    settings.clear();
    settings.set("anthropic_api_key", "sk-ant-test");
    settings.set("default_provider", "anthropic");
    settings.set("telegram_bot_token:smithers-u1", "123:personal-bot");
    settings.set("telegram_bot_token:kb-agent", "456:shared-bot");
  });

  afterEach(() => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_SECRETS_PATH;
    delete process.env.OPENCLAW_SECRETS_PATH_IN_OPENCLAW;
    delete process.env.WORKSPACE_BASE_PATH;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    rmSync(tmpSecretsDir, { recursive: true, force: true });
    rmSync(tmpWorkspaces, { recursive: true, force: true });
  });

  const readEmitted = () =>
    JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf-8")) as Json;

  it("emits the keyed roster and current key layout, and OpenClaw loads it", async () => {
    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    expect(await freshOpenClawLoader()).not.toThrow();

    const emitted = readEmitted();
    const agents = emitted.agents as Json;
    expect(agents.list).toBeUndefined();
    expect(agents.ownership).toBe("explicit");
    expect(Object.keys(agents.entries as Json).sort()).toEqual([
      "kb-agent",
      "odoo-agent",
      "smithers-u1",
    ]);
    const peerKinds = ((emitted.bindings as Json[]) ?? [])
      .map((b) => ((b.match as Json).peer as Json | undefined)?.kind)
      .filter(Boolean);
    expect(peerKinds).toEqual(["direct"]);
    expect((emitted.attachments as Json).ttlHours).toBe(48);
    expect(emitted.canvasHost).toBeUndefined();
    expect(emitted.media).toBeUndefined();
  }, 60_000);

  it("migrates an openclaw.json an earlier Pinchy wrote and drops roster references to removed agents", async () => {
    // What Pinchy on OpenClaw 2026.7 left on disk, plus what OpenClaw 2026.9
    // stamps onto a roster when it first grows past one agent — here pointing
    // at an agent Pinchy has since deleted.
    const previous = {
      gateway: { mode: "local", bind: "lan" },
      canvasHost: { enabled: false },
      media: { ttlHours: 48 },
      talk: { agentId: "deleted-agent" },
      agents: {
        defaults: {
          contextTokens: 262144,
          memorySearch: { provider: "local", local: { modelPath: "/models/x.gguf" } },
          systemAgent: { agentId: "deleted-agent" },
          heartbeat: { agentId: "deleted-agent" },
          authInheritance: { agentId: "deleted-agent" },
        },
        list: [
          { id: "smithers-u1", name: "Smithers", model: MODEL },
          { id: "deleted-agent", name: "Gone", model: MODEL },
        ],
      },
      bindings: [
        {
          agentId: "smithers-u1",
          match: { channel: "telegram", accountId: "smithers-u1", peer: { kind: "dm", id: "1" } },
        },
      ],
    };
    writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(previous, null, 2));

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    expect(await freshOpenClawLoader()).not.toThrow();

    const emitted = readEmitted();
    expect(JSON.stringify(emitted)).not.toContain("deleted-agent");
    const defaults = (emitted.agents as Json).defaults as Json;
    expect(defaults.contextTokens).toBeUndefined();
    expect(defaults.memorySearch).toBeUndefined();
    expect(((emitted.memory as Json).search as Json).provider).toBe("local");
  }, 60_000);

  it("lets OpenClaw start on an earlier Pinchy's file after the boot seed alone", async () => {
    // On an upgraded install OpenClaw starts before any regenerate can run —
    // the first regenerate waits for its gateway. The boot seed is the only
    // write in between, so the file it leaves has to load on its own.
    const previous = {
      gateway: { mode: "local", bind: "lan", auth: { mode: "token", token: "t".repeat(48) } },
      canvasHost: { enabled: false },
      media: { ttlHours: 48 },
      agents: {
        defaults: {
          contextTokens: 262144,
          memorySearch: { provider: "local", local: { modelPath: "/models/x.gguf" } },
        },
        list: [
          {
            id: "smithers-u1",
            name: "Smithers",
            model: MODEL,
            workspace: join(tmpWorkspaces, "a"),
          },
          { id: "kb-agent", name: "Handbook", model: MODEL, workspace: join(tmpWorkspaces, "b") },
        ],
      },
      bindings: [
        {
          agentId: "smithers-u1",
          match: { channel: "telegram", accountId: "smithers-u1", peer: { kind: "dm", id: "1" } },
        },
      ],
    };
    writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(previous, null, 2));

    // The scenario has to be real: OpenClaw refuses this file as it is.
    const loadConfig = await freshOpenClawLoader();
    expect(loadConfig).toThrow(/canvasHost/);

    const { seedRestartClassOverridesIfMissing } = await import("@/lib/openclaw-config");
    expect(seedRestartClassOverridesIfMissing()).toBe(true);

    expect(loadConfig).not.toThrow();
  }, 60_000);

  it("keeps the roster stamps OpenClaw wrote for an agent that still exists", async () => {
    const previous = {
      gateway: { mode: "local", bind: "lan" },
      talk: { agentId: "smithers-u1" },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "smithers-u1" } },
        entries: { "smithers-u1": { name: "Smithers", model: MODEL } },
      },
    };
    writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(previous, null, 2));

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    const emitted = readEmitted();
    expect((emitted.talk as Json).agentId).toBe("smithers-u1");
    expect((((emitted.agents as Json).defaults as Json).systemAgent as Json).agentId).toBe(
      "smithers-u1"
    );
  }, 60_000);
});
