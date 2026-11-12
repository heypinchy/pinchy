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
  private writes = 0;
  private hung: ((err: Error) => void)[] = [];

  constructor(initial: Json) {
    this.file = initial;
    this.runtime = initial;
    fileContent = () => serialize(this.file);
    // A direct write of openclaw.json: OpenClaw's watcher reloads it.
    onConfigFileWrite = (content) => {
      this.commit(JSON.parse(content) as Json);
      this.runtime = this.file;
    };
  }

  private roster(config: Json = this.file): string[] {
    return Object.keys((((config.agents ?? {}) as Json).entries ?? {}) as Json);
  }

  /** Every write supersedes the reloads a hung apply is waiting on. */
  private commit(next: Json) {
    this.writes++;
    this.file = next;
    const waiting = this.hung;
    this.hung = [];
    for (const answer of waiting) {
      answer(
        new Error(
          "config.apply persisted but was not applied to the active Gateway (superseded); run config.get, then use config.apply to reapply the saved config or restart the Gateway"
        )
      );
    }
  }

  client = {
    config: {
      // The materialized runtime, SecretRef ids redacted: never a payload.
      get: vi.fn(async () => ({
        hash: `h${this.writes}`,
        config: {
          ...structuredClone(this.runtime),
          models: {
            providers: {
              anthropic: { ...providers.anthropic, apiKey: "__OPENCLAW_REDACTED__" },
            },
          },
        },
        parsed: structuredClone(this.file),
      })),
      apply: vi.fn(async (raw: string) => {
        const next = JSON.parse(raw) as Json;
        this.applies.push(next);
        const kept = new Set(this.roster(next));
        const dropped = this.roster().filter((id) => !kept.has(id));
        if (dropped.length > 0) {
          throw new Error(
            `Config write would drop agent roster entries without an explicit deletion: ${dropped.sort().join(", ")}.`
          );
        }
        const unchanged = isDeepStrictEqual(withoutMeta(next), withoutMeta(this.runtime));
        this.commit(next);
        const overtaken = this.watcherWins?.(this.applies.length) === true;
        if (overtaken) this.runtime = next;
        if (!unchanged && !overtaken) {
          this.runtime = next;
          return { ok: true };
        }
        // Persisted; the reload hangs until the next write — or until the
        // client's own 30 s request timeout.
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
      }),
    },
    request: vi.fn(async (method: string, params: Json) => {
      if (method !== "agents.delete") throw new Error(`unexpected method ${method}`);
      this.deletes.push(params);
      const agentId = params.agentId as string;
      if (!this.roster().includes(agentId)) throw new Error(`agent "${agentId}" not found`);
      const agents = (this.file.agents ?? {}) as Json;
      const entries = { ...((agents.entries ?? {}) as Json) };
      delete entries[agentId];
      this.commit({ ...this.file, agents: { ...agents, entries } });
      this.runtime = this.file;
      return { type: "res", id: "1", ok: true, payload: { ok: true, agentId } };
    }),
  };
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
    expect(oc.deletes).toEqual([{ agentId: "c", deleteFiles: false }]);
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
});
