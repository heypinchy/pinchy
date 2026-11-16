// pushConfigInBackground against an OpenClaw 2026.9 whose config.apply hangs.
//
// 2026.9 never settles a config.apply whose effective config the runtime
// already holds while a SecretRef is configured: the handler persists the file,
// its reload path throws "superseded", and the call answers only when the next
// write arrives ("config.apply persisted but was not applied to the active
// Gateway (superseded)"). With nothing else writing, openclaw-node gives up
// after 30 s ("Request config.apply timed out"). And config.get's `config` is
// the materialized runtime with every SecretRef id redacted, so it never
// equals a payload: openclaw.json is the only witness of what OpenClaw holds.
//
// The Eval Harness Self-Test hit both shapes after an agent was deleted (CI run
// 43212486821): the roster-removal bridge re-sent a config the file already
// held, hung three rounds, ended in a file fallback, and the file-only delivery
// that fallback left pending switched the no-op guard off for every later push
// — each then hung 5 × 30 s, so configPushesPending never stayed at 0.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isDeepStrictEqual } from "node:util";

const mockGetClient = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

// Every agent these pushes drop is deleted in Pinchy's database.
vi.mock("@/lib/openclaw-config/live-agents", () => ({
  liveAgentIds: async () => new Set<string>(),
}));

let fileContent: (() => string) | undefined;
let onConfigFileWrite: ((content: string) => void) | undefined;
const mockWriteFileSync = vi.fn();
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
  readFileSync: (path: string) => {
    if (fileContent && String(path).endsWith("openclaw.json")) return fileContent();
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  },
}));

import { pushConfigInBackground, _supersedePendingPushes } from "@/lib/openclaw-config/write";
import {
  getPendingConfigPushCount,
  _resetConfigPushState,
  noteFileOnlyDelivery,
  fileOnlyDeliveryPending,
} from "@/lib/openclaw-config/push-state";

type Json = Record<string, unknown>;
const serialize = (c: Json) => JSON.stringify(c, null, 2).trimEnd() + "\n";
const withoutMeta = ({ meta: _meta, ...rest }: Json) => rest;
const revisionOf = (c: Json) => `r:${serialize(c)}`;

const gateway = { mode: "local", bind: "lan", auth: { mode: "token", token: "t".repeat(40) } };
const providers = {
  anthropic: {
    api: "anthropic-messages",
    apiKey: { source: "file", provider: "pinchy", id: "/providers/anthropic/apiKey" },
  },
};

class FakeOpenClaw209 {
  /** openclaw.json as authored. */
  file: Json;
  /** What the running gateway holds. */
  runtime: Json;
  applies: Json[] = [];
  deletes: Json[] = [];
  /**
   * Applies (1-based) whose reload OpenClaw's file watcher overtakes: the
   * watcher loads the persisted file, and the apply itself hangs like a no-op.
   */
  watcherWins?: (apply: number) => boolean;
  /** config.get calls (1-based) that fail transiently, each costing a backoff slot. */
  getFails?: (call: number) => boolean;
  /**
   * What OpenClaw's writer adds to a config on its way to disk, so the file
   * holds more than the payload that was sent.
   */
  normalize?: (config: Json) => Json;
  /**
   * How long a write that changes the config (an apply, agents.delete) takes
   * to reload: until its answer, or — for an apply the watcher overtook, which
   * is never answered — until appliedConfigHash is published.
   */
  reloadMs = 0;
  /** How long an apply takes to persist openclaw.json after it arrives. */
  persistMs = 0;
  /**
   * config.get's appliedConfigHash: the revision of the file the runtime has
   * applied. Like OpenClaw's, every hash here derives from content, so a
   * write of the same bytes moves none of them. OpenClaw publishes it once a
   * reload has finished, prepared model runtime included — whether or not
   * the apply is answered.
   */
  private appliedRevision: string;
  /** Writes (config.apply, agents.delete) in flight now, and the most at once. */
  private writesInFlight = 0;
  maxWritesInFlight = 0;
  private gets = 0;
  private writes = 0;
  private hung: ((err: Error) => void)[] = [];

  constructor(initial: Json) {
    this.file = initial;
    this.runtime = initial;
    this.appliedRevision = revisionOf(initial);
    fileContent = () => serialize(this.file);
    // A direct write of openclaw.json: OpenClaw's watcher reloads it.
    onConfigFileWrite = (content) => {
      this.commit(JSON.parse(content) as Json);
      this.runtime = this.file;
      this.appliedRevision = revisionOf(this.file);
    };
  }

  private roster(config: Json = this.file): string[] {
    return Object.keys((((config.agents ?? {}) as Json).entries ?? {}) as Json);
  }

  /** Every write supersedes the reloads a hung apply is waiting on. */
  private commit(next: Json) {
    this.writes++;
    this.file = next;
    this.answerHung("superseded");
  }

  client = {
    config: {
      // The materialized runtime, SecretRef ids redacted: never a payload.
      get: vi.fn(async () => {
        if (this.getFails?.(++this.gets) === true) throw new Error("socket hang up");
        return this.snapshot();
      }),
      apply: vi.fn(async (raw: string) => this.tracked(() => this.apply(raw))),
    },
    request: vi.fn(async (method: string, params: Json) =>
      this.tracked(() => this.request(method, params))
    ),
  };

  private async tracked<T>(write: () => Promise<T>): Promise<T> {
    this.writesInFlight++;
    this.maxWritesInFlight = Math.max(this.maxWritesInFlight, this.writesInFlight);
    try {
      return await write();
    } finally {
      this.writesInFlight--;
    }
  }

  private snapshot() {
    return {
      hash: `h:${serialize(this.file)}`,
      configRevisionHash: revisionOf(this.file),
      appliedConfigHash: this.appliedRevision,
      config: {
        ...structuredClone(this.runtime),
        models: {
          providers: {
            anthropic: { ...providers.anthropic, apiKey: "__OPENCLAW_REDACTED__" },
          },
        },
      },
      parsed: structuredClone(this.file),
    };
  }

  /** Answers a hung apply with OpenClaw's own text for the given reload outcome. */
  answerHung(outcome: string) {
    const waiting = this.hung;
    this.hung = [];
    for (const answer of waiting) {
      answer(
        new Error(
          `config.apply persisted but was not applied to the active Gateway (${outcome}); run config.get, then use config.apply to reapply the saved config or restart the Gateway`
        )
      );
    }
  }

  private async apply(raw: string) {
    const sent = JSON.parse(raw) as Json;
    this.applies.push(sent);
    const next = this.normalize ? this.normalize(sent) : sent;
    const kept = new Set(this.roster(next));
    const dropped = this.roster().filter((id) => !kept.has(id));
    if (dropped.length > 0) {
      throw new Error(
        `Config write would drop agent roster entries without an explicit deletion: ${dropped.sort().join(", ")}.`
      );
    }
    const unchanged = isDeepStrictEqual(withoutMeta(next), withoutMeta(this.runtime));
    if (this.persistMs > 0) await new Promise((r) => setTimeout(r, this.persistMs));
    this.commit(next);
    const writes = this.writes;
    const revision = revisionOf(next);
    // A newer write publishes its own revision; a reload it overtook never does.
    const publish = () => {
      if (this.writes === writes) this.appliedRevision = revision;
    };
    const overtaken = this.watcherWins?.(this.applies.length) === true;
    if (!unchanged) {
      this.runtime = next;
      if (this.reloadMs > 0) await new Promise((r) => setTimeout(r, this.reloadMs));
      publish();
      if (!overtaken) return { ok: true };
    }
    // Persisted; the reload hangs until the next write — or until the
    // client's own 30 s request timeout. When the watcher overtook it, the
    // runtime holds the write all the same.
    return new Promise((_resolve, reject) => {
      let done = false;
      const answer = (err: Error) => {
        if (done) return;
        done = true;
        reject(err);
      };
      this.hung.push(answer);
      setTimeout(() => answer(new Error("Request config.apply timed out")), 30_000);
    });
  }

  private async request(method: string, params: Json) {
    if (method !== "agents.delete") throw new Error(`unexpected method ${method}`);
    this.deletes.push(params);
    const agentId = params.agentId as string;
    if (!this.roster().includes(agentId)) throw new Error(`agent "${agentId}" not found`);
    const agents = (this.file.agents ?? {}) as Json;
    const entries = { ...((agents.entries ?? {}) as Json) };
    delete entries[agentId];
    this.commit({ ...this.file, agents: { ...agents, entries } });
    this.runtime = this.file;
    const writes = this.writes;
    const revision = revisionOf(this.file);
    if (this.reloadMs > 0) await new Promise((r) => setTimeout(r, this.reloadMs));
    if (this.writes === writes) this.appliedRevision = revision;
    return { type: "res", id: "1", ok: true, payload: { ok: true, agentId } };
  }
}

function configFileWrites() {
  return mockWriteFileSync.mock.calls.filter(
    (c) => typeof c[0] === "string" && (c[0] as string).endsWith("openclaw.json.tmp")
  );
}

/** Advances fake time until every push settled; returns the time it took. */
async function settle(limitMs = 600_000): Promise<number> {
  let elapsed = 0;
  while (getPendingConfigPushCount() > 0 && elapsed < limitMs) {
    await vi.advanceTimersByTimeAsync(100);
    elapsed += 100;
  }
  expect(getPendingConfigPushCount(), "push coroutine never settled").toBe(0);
  return elapsed;
}

describe("pushConfigInBackground: OpenClaw 2026.9's hanging config.apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _supersedePendingPushes();
    _resetConfigPushState();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fileContent = undefined;
    onConfigFileWrite = undefined;
    vi.restoreAllMocks();
  });

  it("removes a deleted agent without re-sending a roster bridge openclaw.json already holds", async () => {
    // The bridge — the target with the deleted agent kept — persists, but its
    // reload loses to the file watcher and the apply hangs. Every re-send of it
    // is then a no-op apply, which hangs as well; three rounds of that ended
    // in the file fallback and a pending file-only delivery.
    const before = {
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: { a: {}, b: {}, c: {} } },
    };
    const oc = new FakeOpenClaw209(before);
    // Apply 1 is the target, refused for dropping "c"; apply 2 the bridge.
    oc.watcherWins = (apply) => apply === 2;
    mockGetClient.mockReturnValue(oc.client);
    const onChangeApplied = vi.fn();
    const target = {
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: { a: {}, b: {} } },
    };

    pushConfigInBackground(serialize(target), { onChangeApplied });
    const took = await settle();

    expect(oc.file).toEqual(target);
    expect(oc.deletes).toEqual([{ agentId: "c", deleteFiles: true }]);
    // Never past OpenClaw's roster guard through the file.
    expect(configFileWrites()).toHaveLength(0);
    expect(fileOnlyDeliveryPending()).toBe(false);
    expect(onChangeApplied).toHaveBeenCalledTimes(1);
    // The bridge's own hang, and no other.
    expect(took).toBeLessThanOrEqual(31_000);
  });

  it("stops at an apply OpenClaw persisted but never answered, instead of re-sending it four more times", async () => {
    // A file-only delivery is pending (an earlier fallback wrote the file), so
    // the no-op guard stands aside and the push sends its config. OpenClaw
    // already holds it: the apply is persisted and hangs. Re-sending the file's
    // own content cannot deliver anything that one did not, and each re-send
    // hangs another 30 s.
    const config = {
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: { a: {} } },
    };
    const oc = new FakeOpenClaw209(config);
    mockGetClient.mockReturnValue(oc.client);
    noteFileOnlyDelivery();

    pushConfigInBackground(serialize(config));
    const took = await settle();

    expect(oc.applies).toHaveLength(1);
    expect(took).toBeLessThanOrEqual(31_000);
    expect(configFileWrites()).toHaveLength(0);
    // The file this push's apply persisted is what OpenClaw runs on: a hung
    // apply is one whose config the runtime already holds, so the pending
    // file-only delivery is settled — and the guard is back for the next push.
    expect(fileOnlyDeliveryPending()).toBe(false);

    pushConfigInBackground(serialize(config));
    await settle();
    expect(oc.applies).toHaveLength(1);
  });

  it("takes a 'superseded' answer for its own persisted apply as delivered when it is still the newest push", async () => {
    const config = {
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: { a: {}, b: {} } },
    };
    const oc = new FakeOpenClaw209(config);
    mockGetClient.mockReturnValue(oc.client);
    noteFileOnlyDelivery();
    const onChangeApplied = vi.fn();

    pushConfigInBackground(serialize(config), { onChangeApplied });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oc.applies).toHaveLength(1);
    // Something other than a Pinchy push writes the same file (OpenClaw's own
    // bookkeeping): the hung reload is superseded by one that loads it.
    oc.file = { ...oc.file, meta: { lastTouchedVersion: "2026.9.2" } };
    (oc as unknown as { commit: (next: Json) => void }).commit(oc.file);
    await settle();

    expect(oc.applies).toHaveLength(1);
    expect(fileOnlyDeliveryPending()).toBe(false);
    expect(onChangeApplied).toHaveBeenCalledTimes(1);
  });

  it("still removes the agent when the bridge hangs on the push's last attempt", async () => {
    // Four transient failures spend every backoff slot but the last. A bridge
    // that hangs there is persisted all the same: agents.delete still follows,
    // instead of the file fallback past OpenClaw's roster guard.
    const before = {
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: { a: {}, b: {}, c: {} } },
    };
    const oc = new FakeOpenClaw209(before);
    oc.getFails = (call) => call <= 4;
    oc.watcherWins = (apply) => apply === 2;
    mockGetClient.mockReturnValue(oc.client);
    const onChangeApplied = vi.fn();
    const target = {
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: { a: {}, b: {} } },
    };

    pushConfigInBackground(serialize(target), { onChangeApplied });
    await settle();

    expect(oc.file).toEqual(target);
    expect(onChangeApplied).toHaveBeenCalledTimes(1);
    expect(oc.deletes).toEqual([{ agentId: "c", deleteFiles: true }]);
    expect(configFileWrites()).toHaveLength(0);
    expect(fileOnlyDeliveryPending()).toBe(false);
  });

  it("sends no write while an older push's apply is still reloading, and only the newest push's", async () => {
    // A burst of agent creates: each starts a push while the previous apply's
    // reload is still running. A second apply on top of a running reload
    // supersedes its prepared model runtime publication, and OpenClaw 2026.9
    // books that as a failed hot reload: "recovery deferred to the newer
    // config" — a gateway restart the next accepted reload pays, dropping every
    // running chat (staging, 2026-11-14).
    const config = (ids: string[]) => ({
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: Object.fromEntries(ids.map((id) => [id, {}])) },
    });
    const oc = new FakeOpenClaw209(config(["a"]));
    oc.reloadMs = 5_000;
    mockGetClient.mockReturnValue(oc.client);
    const applied = [vi.fn(), vi.fn(), vi.fn()];

    pushConfigInBackground(serialize(config(["a", "b"])), { onChangeApplied: applied[0] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oc.applies).toHaveLength(1);
    pushConfigInBackground(serialize(config(["a", "b", "c"])), { onChangeApplied: applied[1] });
    pushConfigInBackground(serialize(config(["a", "b", "c", "d"])), {
      onChangeApplied: applied[2],
    });
    await settle();

    expect(oc.maxWritesInFlight).toBe(1);
    // The middle push is superseded while it waits: the burst costs two applies.
    expect(oc.applies).toHaveLength(2);
    expect(oc.file).toEqual(config(["a", "b", "c", "d"]));
    expect(applied.map((f) => f.mock.calls.length)).toEqual([1, 0, 1]);
    expect(configFileWrites()).toHaveLength(0);
  });

  it("sends a newer push's apply neither during the roster bridge's reload nor during its agents.delete", async () => {
    // The bridge's answer takes its reload's time, and a newer push queued
    // behind it wakes when it is answered — just as this push goes on to
    // agents.delete, which reloads as well.
    const config = (ids: string[]) => ({
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: Object.fromEntries(ids.map((id) => [id, {}])) },
    });
    const oc = new FakeOpenClaw209(config(["a", "b", "c"]));
    oc.reloadMs = 5_000;
    mockGetClient.mockReturnValue(oc.client);

    pushConfigInBackground(serialize(config(["a", "b"])));
    // Apply 1 is the target, refused for dropping "c"; apply 2 the bridge.
    for (let t = 0; t < 50 && oc.applies.length < 2; t++) await vi.advanceTimersByTimeAsync(10);
    expect(oc.applies).toHaveLength(2);
    pushConfigInBackground(serialize(config(["a", "b", "d"])));
    await settle();

    expect(oc.maxWritesInFlight).toBe(1);
    expect(oc.deletes).toEqual([{ agentId: "c", deleteFiles: true }]);
    expect(oc.file).toEqual(config(["a", "b", "d"]));
  });

  it("does not wait out the request timeout behind an apply OpenClaw will never answer", async () => {
    // An apply whose config the runtime already holds hangs until the next
    // write; a newer push is that write. Waiting for it to settle would add the
    // full 30 s request timeout to every change behind it.
    const config = (ids: string[]) => ({
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: Object.fromEntries(ids.map((id) => [id, {}])) },
    });
    const oc = new FakeOpenClaw209(config(["a"]));
    mockGetClient.mockReturnValue(oc.client);
    noteFileOnlyDelivery();

    pushConfigInBackground(serialize(config(["a"])));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oc.applies).toHaveLength(1);
    pushConfigInBackground(serialize(config(["a", "b"])));
    // Nothing in config.get moved — the write left the bytes as they were —
    // so only the wait cap lets the push go.
    await vi.advanceTimersByTimeAsync(13_000);
    expect(oc.applies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7_000);

    expect(oc.applies).toHaveLength(2);
    expect(oc.file).toEqual(config(["a", "b"]));
    await settle();
  });

  it("does not hold a push for the wait cap behind an apply OpenClaw applied but never answered", async () => {
    // 2026.9 often answers config.apply only when the next write supersedes
    // it, although its reload has long finished. Waiting for that answer cost
    // every push the full CONFIG_WRITE_MAX_WAIT_MS — a Telegram disconnect
    // landed 30–40 s late (CI, release/0.11, run 43708131974). config.get's
    // appliedConfigHash says when the runtime holds what the file holds.
    const config = (ids: string[]) => ({
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: Object.fromEntries(ids.map((id) => [id, {}])) },
    });
    const oc = new FakeOpenClaw209(config(["a"]));
    oc.reloadMs = 2_000;
    oc.watcherWins = (apply) => apply === 1;
    mockGetClient.mockReturnValue(oc.client);

    pushConfigInBackground(serialize(config(["a", "b"])));
    await vi.advanceTimersByTimeAsync(500);
    expect(oc.applies).toHaveLength(1);
    pushConfigInBackground(serialize(config(["a", "b", "c"])));
    // The file moved at once; the runtime holds it only once the reload ends.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oc.applies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(oc.applies).toHaveLength(2);
    expect(oc.file).toEqual(config(["a", "b", "c"]));
    await settle();
  });

  it("keeps a push waiting while the unanswered apply ahead of it has not reached openclaw.json yet", async () => {
    // Before the apply persists, the runtime still holds the file it read —
    // "applied" then says nothing about the write in flight, whose reload has
    // not even started.
    const config = (ids: string[]) => ({
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: Object.fromEntries(ids.map((id) => [id, {}])) },
    });
    const oc = new FakeOpenClaw209(config(["a"]));
    oc.persistMs = 4_000;
    oc.watcherWins = (apply) => apply === 1;
    mockGetClient.mockReturnValue(oc.client);

    pushConfigInBackground(serialize(config(["a", "b"])));
    await vi.advanceTimersByTimeAsync(500);
    expect(oc.applies).toHaveLength(1);
    pushConfigInBackground(serialize(config(["a", "b", "c"])));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(oc.applies).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(oc.applies).toHaveLength(2);
    await settle();
    expect(oc.file).toEqual(config(["a", "b", "c"]));
  });

  it("lets a push queued behind another write go as soon as a newer push supersedes it", async () => {
    // Waiting on would only hold the superseded push for the write's answer —
    // up to CONFIG_WRITE_MAX_WAIT_MS behind an apply OpenClaw has neither
    // answered nor applied — to find out what is already known.
    const config = (ids: string[]) => ({
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: Object.fromEntries(ids.map((id) => [id, {}])) },
    });
    const oc = new FakeOpenClaw209(config(["a"]));
    oc.persistMs = 10_000;
    mockGetClient.mockReturnValue(oc.client);
    noteFileOnlyDelivery();

    pushConfigInBackground(serialize(config(["a"])));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oc.applies).toHaveLength(1);
    oc.persistMs = 0;
    pushConfigInBackground(serialize(config(["a", "b"])));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getPendingConfigPushCount()).toBe(2);
    pushConfigInBackground(serialize(config(["a", "c"])));
    await vi.advanceTimersByTimeAsync(100);

    expect(getPendingConfigPushCount()).toBe(2);
    await settle();
    expect(oc.file).toEqual(config(["a", "c"]));
  });

  it("still delivers a full regenerate's agent when a partial writer supersedes it while it waits for another write", async () => {
    // A regenerate that adds agent "b" queues behind an apply OpenClaw has
    // neither answered nor applied yet. A partial writer (the Telegram channel) supersedes it meanwhile
    // with its copy of openclaw.json, which predates "b". Nothing but the
    // regenerate knew about "b".
    const config = (ids: string[], extra: Json = {}) => ({
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: Object.fromEntries(ids.map((id) => [id, {}])) },
      ...extra,
    });
    const telegram = { channels: { telegram: { enabled: true } } };
    const oc = new FakeOpenClaw209(config(["a"]));
    oc.persistMs = 10_000;
    mockGetClient.mockReturnValue(oc.client);
    noteFileOnlyDelivery();

    pushConfigInBackground(serialize(config(["a"])));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oc.applies).toHaveLength(1);
    oc.persistMs = 0;
    pushConfigInBackground(serialize(config(["a", "b"])), {
      fullRegenerate: true,
      resumeStrandedShrink: () =>
        pushConfigInBackground(serialize(config(["a", "b"], telegram)), { fullRegenerate: true }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    pushConfigInBackground(serialize(config(["a"], telegram)));
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();

    expect(oc.file).toEqual(config(["a", "b"], telegram));
  });

  it("removes the agent after one unanswered bridge, even when openclaw.json is not byte-for-byte the bridge", async () => {
    // OpenClaw's writer adds to what it persists, so the file never equals the
    // bridge Pinchy sent, and the re-sent bridge is a no-op apply that hangs
    // again. Staging, 2026-11-14: three rounds of 30 s, no agents.delete, and
    // the target written into openclaw.json past OpenClaw's roster guard.
    // A plugin entry Pinchy writes without a `config` gains an empty one.
    const plugins = { entries: { "llama-cpp": { enabled: true } } };
    const normalized = { entries: { "llama-cpp": { enabled: true, config: {} } } };
    const before = {
      gateway,
      models: { providers },
      plugins: normalized,
      agents: { ownership: "explicit", entries: { a: {}, b: {}, c: {} } },
    };
    const oc = new FakeOpenClaw209(before);
    oc.normalize = (c) => ({ ...c, plugins: normalized });
    oc.watcherWins = (apply) => apply === 2;
    mockGetClient.mockReturnValue(oc.client);
    const onChangeApplied = vi.fn();
    const target = {
      gateway,
      models: { providers },
      plugins,
      agents: { ownership: "explicit", entries: { a: {}, b: {} } },
    };

    pushConfigInBackground(serialize(target), { onChangeApplied });
    const took = await settle();

    expect(oc.deletes).toEqual([{ agentId: "c", deleteFiles: true }]);
    expect((oc.file.agents as Json).entries as Json).toEqual({ a: {}, b: {} });
    expect(configFileWrites()).toHaveLength(0);
    expect(onChangeApplied).toHaveBeenCalledTimes(1);
    expect(took).toBeLessThanOrEqual(31_000);
  });

  it("keeps a file-only delivery pending when OpenClaw answers that its reload failed", async () => {
    // "(failed)": the hot reload threw, and the runtime does not hold what the
    // file does. Only "superseded" means a newer reload took over the file.
    const config = {
      gateway,
      models: { providers },
      agents: { ownership: "explicit", entries: { a: {} } },
    };
    const oc = new FakeOpenClaw209(config);
    mockGetClient.mockReturnValue(oc.client);
    noteFileOnlyDelivery();
    const onChangeApplied = vi.fn();

    pushConfigInBackground(serialize(config), { onChangeApplied });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oc.applies).toHaveLength(1);
    oc.answerHung("failed");
    await vi.advanceTimersByTimeAsync(1_000);

    // Retried, not taken as delivered.
    expect(oc.applies.length).toBeGreaterThan(1);
    expect(fileOnlyDeliveryPending()).toBe(true);
    _supersedePendingPushes();
    await settle();
  });
});
