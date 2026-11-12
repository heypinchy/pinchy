// pushConfigInBackground against an OpenClaw that guards its agent roster the
// way 2026.9.2 does.
//
// config.apply refuses any write that drops an agent from the roster ("Config
// write would drop agent roster entries without an explicit deletion: <ids>")
// and takes no parameter to lift that; only the gateway's own agents.delete
// may remove one. Pinchy replaces the roster wholesale, so two everyday
// changes reach OpenClaw as such a write: deleting an agent, and a fresh
// install's first agent, which drops the implicit "main" OpenClaw assumes for
// a file with no roster. Without handling, the push retries the refused apply
// and then writes the file behind OpenClaw's back — bypassing its guard, and
// leaving the deleted agent's sessions and cron jobs to OpenClaw's file
// watcher, which does not clean them up.
//
// The fake models the parts of OpenClaw that decide the outcome: the roster
// check against the current file (an empty roster counting as "main" unless
// ownership is explicit), and agents.delete's refusals (unknown agent, sole
// agent, the agent others inherit auth from, and the implicit "main", which on
// a Pinchy install owns OpenClaw's legacy shared auth store).
// integration/openclaw-config-roster-removal-against-oc.test.ts runs the same
// changes against the real OpenClaw handlers.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockGetClient = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

const mockWriteFileSync = vi.fn();
// writeConfigAtomic writes openclaw.json.tmp, then renames it into place.
let onConfigFileWrite: ((content: string) => void) | undefined;
vi.mock("fs", () => ({
  existsSync: () => true,
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  writeFileSync: (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].endsWith("openclaw.json.tmp")) {
      onConfigFileWrite?.(String(args[1]));
    }
    return mockWriteFileSync(...args);
  },
  readFileSync: () => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  },
}));

import { pushConfigInBackground, _supersedePendingPushes } from "@/lib/openclaw-config/write";
import { getPendingConfigPushCount, _resetConfigPushState } from "@/lib/openclaw-config/push-state";

type Json = Record<string, unknown>;
const serialize = (c: Json) => JSON.stringify(c, null, 2).trimEnd() + "\n";

const gateway = { mode: "local", bind: "lan", auth: { mode: "token", token: "t".repeat(40) } };

class FakeOpenClaw {
  file: Json;
  applies: Json[] = [];
  deletes: Json[] = [];
  private writes = 0;
  /** Makes agents.delete refuse a call (1-based) with the returned message. */
  deleteFailure?: (call: number) => string | undefined;
  constructor(initial: Json) {
    this.file = initial;
    // A direct write of openclaw.json, which OpenClaw's reloader hot-applies.
    onConfigFileWrite = (content) => this.commit(JSON.parse(content) as Json);
  }
  roster(config: Json = this.file): string[] {
    const agents = (config.agents ?? {}) as Json;
    const ids = Object.keys((agents.entries ?? {}) as Json);
    if (ids.length > 0 || agents.ownership === "explicit") return ids;
    return ["main"];
  }
  private commit(next: Json) {
    this.writes++;
    this.file = next;
  }
  client = {
    config: {
      get: vi.fn(async () => ({ hash: `h${this.writes}`, config: structuredClone(this.file) })),
      apply: vi.fn(async (raw: string) => {
        const next = JSON.parse(raw) as Json;
        this.applies.push(next);
        const kept = new Set(
          Object.keys(((next.agents as Json | undefined)?.entries ?? {}) as Json)
        );
        const dropped = (next.agents as Json | undefined)?.entries
          ? this.roster().filter((id) => !kept.has(id))
          : [];
        if (dropped.length > 0) {
          throw new Error(
            `Config write would drop agent roster entries without an explicit deletion: ${dropped.sort().join(", ")}.`
          );
        }
        const entries = Object.keys(((next.agents as Json | undefined)?.entries ?? {}) as Json);
        if (entries.length > 1 && (next.agents as Json).ownership !== "explicit") {
          throw new Error(
            'invalid config: agents.ownership: multi-agent rosters require agents.ownership="explicit"'
          );
        }
        // A roster growing past one agent: OpenClaw hands the roles the sole
        // agent held to it by name, over whatever the write set itself
        // (materializeLegacyDefaultAgentRoles).
        const before = this.roster();
        if (before.length === 1 && entries.length > 1) {
          const agents = next.agents as Json;
          const defaults = (agents.defaults ?? {}) as Json;
          next.agents = {
            ...agents,
            defaults: { ...defaults, authInheritance: { agentId: before[0] } },
          };
        }
        this.commit(next);
        return { ok: true };
      }),
    },
    request: vi.fn(async (method: string, params: Json) => {
      if (method !== "agents.delete") throw new Error(`unexpected method ${method}`);
      this.deletes.push(params);
      const failure = this.deleteFailure?.(this.deletes.length);
      if (failure) throw new Error(failure);
      const agentId = params.agentId as string;
      if (agentId === "main") {
        // The image's seed never ran OpenClaw's shared-auth migration, so the
        // shared store stays "legacy-main" and main stays undeletable.
        throw new Error(
          'Agent "main" owns the legacy shared auth store and cannot be deleted. Run openclaw doctor --fix to migrate shared auth, then retry.'
        );
      }
      const roster = this.roster();
      if (!roster.includes(agentId)) throw new Error(`agent "${agentId}" not found`);
      if (roster.length === 1) {
        throw new Error(`Agent "${agentId}" is the only configured agent and cannot be deleted.`);
      }
      const defaults = ((this.file.agents as Json | undefined)?.defaults ?? {}) as Json;
      const owner = ((defaults.authInheritance ?? {}) as Json).agentId ?? roster[0];
      if (owner === agentId) {
        throw new Error(
          `Agent "${agentId}" owns inherited credentials through agents.defaults.authInheritance.agentId and cannot be deleted.`
        );
      }
      const agents = { ...((this.file.agents ?? {}) as Json) };
      const entries = { ...((agents.entries ?? {}) as Json) };
      delete entries[agentId];
      this.commit({ ...this.file, agents: { ...agents, entries } });
      return { type: "res", id: "1", ok: true, payload: { ok: true, agentId, removedBindings: 0 } };
    }),
  };
}

function configFileWrites() {
  return mockWriteFileSync.mock.calls.filter(
    (c) => typeof c[0] === "string" && (c[0] as string).endsWith("openclaw.json.tmp")
  );
}

async function settle() {
  for (let i = 0; i < 500 && getPendingConfigPushCount() > 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
  expect(getPendingConfigPushCount(), "push coroutine never settled").toBe(0);
}

describe("pushConfigInBackground: a roster change OpenClaw refuses as dropping agents", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _supersedePendingPushes();
    _resetConfigPushState();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    onConfigFileWrite = undefined;
    vi.restoreAllMocks();
  });

  it("removes a deleted agent through OpenClaw's agents.delete, files included", async () => {
    const oc = new FakeOpenClaw({
      gateway,
      agents: {
        ownership: "explicit",
        entries: { a: { name: "A" }, b: { name: "B" }, c: { name: "C" } },
      },
    });
    mockGetClient.mockReturnValue(oc.client);
    const onChangeApplied = vi.fn();
    const target = {
      gateway,
      agents: { ownership: "explicit", entries: { a: { name: "A" }, b: { name: "B" } } },
    };

    pushConfigInBackground(serialize(target), { onChangeApplied });
    await settle();

    expect(oc.file).toEqual(target);
    // deleteFiles: true — without it OpenClaw 2026.9 leaves the agent's
    // database registered while its deletion journal marks the agent deleted,
    // and the next gateway start refuses to come up.
    expect(oc.deletes).toEqual([{ agentId: "c", deleteFiles: true }]);
    expect(configFileWrites()).toHaveLength(0);
    expect(onChangeApplied).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("delivers a fresh install's first agent, retiring OpenClaw's implicit main by a file write", async () => {
    // The start script's seed: no roster, so OpenClaw holds "main" — which
    // agents.delete refuses on every Pinchy install. Pinchy's agent ids are
    // UUIDs, so "main" is only ever OpenClaw's placeholder: the file write
    // drops it the way OpenClaw's own onboarding does, and config.apply then
    // confirms the target reached the runtime.
    const oc = new FakeOpenClaw({ gateway });
    mockGetClient.mockReturnValue(oc.client);
    const onChangeApplied = vi.fn();
    const target = { gateway, agents: { entries: { smithers: { name: "Smithers" } } } };

    pushConfigInBackground(serialize(target), { onChangeApplied });
    await settle();

    expect(oc.file).toEqual(target);
    expect(oc.deletes).toEqual([]);
    expect(configFileWrites()).toHaveLength(1);
    expect(oc.applies.at(-1)).toEqual(target);
    expect(onChangeApplied).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("deletes other dropped agents through agents.delete before retiring main", async () => {
    const oc = new FakeOpenClaw({
      gateway,
      agents: { ownership: "explicit", entries: { main: {}, a: {}, b: {} } },
    });
    mockGetClient.mockReturnValue(oc.client);
    const target = { gateway, agents: { ownership: "explicit", entries: { a: {} } } };

    pushConfigInBackground(serialize(target));
    await settle();

    expect(oc.file).toEqual(target);
    expect(oc.deletes).toEqual([{ agentId: "b", deleteFiles: true }]);
    expect(configFileWrites()).toHaveLength(1);
  });

  it("replaces a sole agent, which agents.delete alone would refuse", async () => {
    // The bridge grows the roster past one agent, so OpenClaw pins the
    // inherited-auth role to "a" over the bridge's choice and refuses the first
    // delete. The next round's bridge changes no roster: OpenClaw takes its
    // authInheritance, and the delete goes through — without a retry backoff.
    const oc = new FakeOpenClaw({ gateway, agents: { entries: { a: { name: "A" } } } });
    mockGetClient.mockReturnValue(oc.client);
    const target = { gateway, agents: { entries: { b: { name: "B" } } } };

    pushConfigInBackground(serialize(target));
    await settle();

    expect(oc.file).toEqual(target);
    expect(oc.deletes).toEqual([
      { agentId: "a", deleteFiles: true },
      { agentId: "a", deleteFiles: true },
    ]);
    expect(configFileWrites()).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("retrying"),
      expect.anything()
    );
  });

  it("re-checks with OpenClaw when agents.delete finds the agent already gone", async () => {
    // Another writer removed it between the refusal and the delete — or, as
    // here, OpenClaw still lists it, and the next round's refusal says so.
    const oc = new FakeOpenClaw({
      gateway,
      agents: { ownership: "explicit", entries: { a: {}, b: {} } },
    });
    mockGetClient.mockReturnValue(oc.client);
    oc.deleteFailure = (call) => (call === 1 ? 'agent "b" not found' : undefined);
    const target = { gateway, agents: { ownership: "explicit", entries: { a: {} } } };

    pushConfigInBackground(serialize(target));
    await settle();

    expect(oc.file).toEqual(target);
    expect(oc.deletes).toHaveLength(2);
    expect(configFileWrites()).toHaveLength(0);
  });

  it("gives up after bounded rounds when agents.delete keeps refusing", async () => {
    // e.g. a refusal OpenClaw adds in a later version. No endless loop of
    // control-plane writes: the push ends in the existing fallback.
    const oc = new FakeOpenClaw({
      gateway,
      agents: { ownership: "explicit", entries: { a: {}, b: {} } },
    });
    mockGetClient.mockReturnValue(oc.client);
    oc.deleteFailure = () =>
      'Agent "b" owns inherited credentials through agents.defaults.authInheritance.agentId and cannot be deleted.';
    // What OpenClaw holds is read below; the fallback's file write is counted instead.
    onConfigFileWrite = undefined;
    const target = { gateway, agents: { ownership: "explicit", entries: { a: {} } } };

    vi.useFakeTimers();
    try {
      pushConfigInBackground(serialize(target));
      for (let i = 0; i < 100 && getPendingConfigPushCount() > 0; i++) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(getPendingConfigPushCount(), "push coroutine never settled").toBe(0);
    } finally {
      vi.useRealTimers();
    }

    expect(oc.deletes.length).toBeGreaterThan(0);
    expect(oc.deletes.length).toBeLessThanOrEqual(3);
    // OpenClaw kept the agent; the push ended in the file fallback a refusal
    // of the config itself takes (CONFIG_REFUSED_ERROR_FRAGMENTS), as before.
    expect((oc.file.agents as Json).entries).toEqual({ a: {}, b: {} });
    expect(configFileWrites()).toHaveLength(1);
  });

  it("makes no agents.delete call for a push that drops no agent", async () => {
    const oc = new FakeOpenClaw({ gateway, agents: { entries: { a: { name: "A" } } } });
    mockGetClient.mockReturnValue(oc.client);
    const target = {
      gateway,
      agents: { ownership: "explicit", entries: { a: { name: "A" }, b: {} } },
    };

    pushConfigInBackground(serialize(target));
    await settle();

    // Plus the roles OpenClaw hands to "a" as the roster grows past one agent.
    expect((oc.file.agents as Json).entries).toEqual(target.agents.entries);
    expect(oc.applies).toHaveLength(1);
    expect(oc.client.request).not.toHaveBeenCalled();
  });
});
