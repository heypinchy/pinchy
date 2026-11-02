// pushConfigInBackground against an OpenClaw that enforces its own size-drop
// rule, the way 2026.7.1's `config.apply` does.
//
// OpenClaw refuses any config write that is under half of the file it replaces
// (`size-drop:OLD->NEW`, baseline = the current openclaw.json, >= 512 bytes),
// and no RPC parameter lifts that: config.apply, config.patch and config.set
// all commit through the same writer. Deleting a large provider is such a
// write. Before this fix the push retried the refused apply five times and then
// fell back to writing the file directly — which bypasses OpenClaw's clobber
// guard, and which OpenClaw's own read path reverts (`.bak` restore,
// `size-drop-vs-last-good`) on its next start.
//
// The fake below models the parts of OpenClaw that decide the outcome: the
// 50% rule against the current file, the meta stamp OpenClaw adds to every
// write (so its byte count differs from ours), and SecretRef resolution
// against a secrets file that no longer holds the deleted provider's key.
// integration/openclaw-config-size-drop-against-oc.test.ts runs the same
// stepping against the real OpenClaw writer.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockGetClient = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

const mockWriteFileSync = vi.fn();
vi.mock("fs", () => ({
  existsSync: () => true,
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  readFileSync: () => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  },
}));

import { pushConfigInBackground, _supersedePendingPushes } from "@/lib/openclaw-config/write";
import {
  getPendingConfigPushCount,
  _resetConfigPushState,
  nextRegenerateSequence,
  undeliveredConfigChange,
} from "@/lib/openclaw-config/push-state";

type Json = Record<string, unknown>;
const bytes = (s: string) => Buffer.byteLength(s, "utf-8");
const serialize = (c: Json) => JSON.stringify(c, null, 2).trimEnd() + "\n";

function model(i: number) {
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

const anthropicRef = { source: "file", provider: "pinchy", id: "/providers/anthropic/apiKey" };
const acmeRef = { source: "file", provider: "pinchy", id: "/providers/acme-llm/apiKey" };

function pinchyConfig(extraProviders: Json = {}, extra: Json = {}): Json {
  return {
    gateway: { mode: "local", bind: "lan", auth: { mode: "token", token: "t".repeat(40) } },
    agents: { list: [{ id: "smithers", name: "Smithers", model: "anthropic/claude" }] },
    models: {
      providers: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          apiKey: anthropicRef,
          models: [{ id: "claude", name: "Claude" }],
        },
        ...extraProviders,
      },
    },
    ...extra,
  };
}

const acmeProvider = {
  baseUrl: "https://acme.example/v1",
  api: "openai-completions",
  apiKey: acmeRef,
  models: Array.from({ length: 40 }, (_, i) => model(i)),
};

/** The subset of OpenClaw's config.apply that decides a shrinking write. */
class FakeOpenClaw {
  file: string;
  applies: string[] = [];
  rejections: string[] = [];
  /** Accepted writes, in order. */
  accepted: string[] = [];
  /** Runs after every accepted write — lets a test interleave another writer. */
  onAccepted?: (acceptedCount: number) => void;
  /** Rate-limits the n-th apply (1-based) when it returns true. */
  rateLimitWhen?: (applyCount: number) => boolean;
  private writes = 0;
  constructor(
    initial: Json,
    private readonly resolvableSecretIds: Set<string>,
    private readonly rateLimitEvery = 0
  ) {
    this.file = this.stamp(initial);
  }
  private stamp(config: Json): string {
    this.writes++;
    return serialize({
      ...config,
      meta: {
        lastTouchedVersion: "2026.7.1-2",
        lastTouchedAt: `2026-11-02T00:00:0${this.writes % 10}Z`,
      },
    });
  }
  client = {
    config: {
      get: vi.fn(async () => ({ hash: `h${this.writes}`, config: JSON.parse(this.file) as Json })),
      apply: vi.fn(async (raw: string) => {
        this.applies.push(raw);
        if (
          (this.rateLimitEvery && this.applies.length % this.rateLimitEvery === 0) ||
          this.rateLimitWhen?.(this.applies.length)
        ) {
          throw new Error("rate limit exceeded for config.apply; retry after 1s");
        }
        const parsed = JSON.parse(raw) as Json;
        for (const p of Object.values(
          ((parsed.models as Json | undefined)?.providers ?? {}) as Record<string, Json>
        )) {
          const ref = p.apiKey as { id?: string } | undefined;
          if (ref?.id && !this.resolvableSecretIds.has(ref.id)) {
            throw new Error(`unresolved SecretRef ${ref.id}`);
          }
        }
        const next = this.stamp(parsed);
        const base = bytes(this.file);
        if (base >= 512 && bytes(next) < Math.floor(base * 0.5)) {
          const message = `Config write rejected: /root/.openclaw/openclaw.json (size-drop:${base}->${bytes(next)}). Rejected payload saved to /root/.openclaw/openclaw.json.rejected.x.`;
          this.rejections.push(message);
          throw new Error(message);
        }
        this.file = next;
        this.accepted.push(next);
        this.onAccepted?.(this.accepted.length);
        return { ok: true };
      }),
    },
  };
  providers(): Json {
    return (JSON.parse(this.file) as { models: { providers: Json } }).models.providers;
  }
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

/** Run every push to completion under fake timers, then past the follow-up debounce. */
async function drainWithFakeTimers() {
  for (let i = 0; i < 200 && getPendingConfigPushCount() > 0; i++) {
    await vi.advanceTimersByTimeAsync(5_000);
  }
  expect(getPendingConfigPushCount(), "push coroutine never settled").toBe(0);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
}

describe("pushConfigInBackground: a shrink OpenClaw refuses as size-drop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _supersedePendingPushes();
    _resetConfigPushState();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delivers a deleted large provider through config.apply steps OpenClaw accepts", async () => {
    // secrets.json already lost the deleted provider's key (writeSecretsFile
    // runs before the push).
    const oc = new FakeOpenClaw(
      pinchyConfig({ "acme-llm": acmeProvider }),
      new Set([anthropicRef.id])
    );
    mockGetClient.mockReturnValue(oc.client);
    const target = serialize(pinchyConfig());
    expect(bytes(target), "precondition: a one-shot apply is a size-drop").toBeLessThan(
      bytes(oc.file) / 2
    );
    const onChangeApplied = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(target, { onChangeApplied });
    await settle();

    expect(errorSpy.mock.calls.flat().join(" ")).toBe("");
    // The deletion reached OpenClaw's runtime config…
    expect(oc.providers()).not.toHaveProperty("acme-llm");
    expect(oc.providers()).toHaveProperty("anthropic");
    // …through more than one accepted write, i.e. in steps…
    const accepted = oc.applies.length - oc.rejections.length;
    expect(accepted).toBeGreaterThan(1);
    // …calibrated from a single refusal, not by retrying into each one.
    expect(oc.rejections).toHaveLength(1);
    // …and never by forcing the file past OpenClaw's guard.
    expect(configFileWrites()).toHaveLength(0);
    expect(onChangeApplied).toHaveBeenCalledTimes(1);
  });

  it("does not write a refused shrink to the file when no provider explains it (#311/#314)", async () => {
    // OpenClaw's file carries 9 kB of state the payload lost outside
    // models.providers — the stale/racy payload shape of #314. Stepping cannot
    // explain that, and writing it to disk is exactly the cascade #311 exists
    // to stop.
    const oc = new FakeOpenClaw(
      pinchyConfig({}, { secrets: { padding: "x".repeat(9000) } }),
      new Set([anthropicRef.id])
    );
    mockGetClient.mockReturnValue(oc.client);
    const onChangeApplied = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), { onChangeApplied });
    await settle();

    expect(oc.applies).toHaveLength(1);
    expect(configFileWrites()).toHaveLength(0);
    expect(onChangeApplied).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/size-drop/);
    expect(JSON.parse(oc.file).secrets).toEqual({ padding: "x".repeat(9000) });
  });

  it("keeps stepping through OpenClaw's config.apply rate limit instead of falling back to a file write", async () => {
    // OpenClaw allows ~3 config.apply calls per window; a 10x shrink needs
    // more steps than that. Progress between waits must not count against the
    // rate-limit budget, or the push would give up half-way.
    vi.useFakeTimers();
    const oc = new FakeOpenClaw(
      pinchyConfig({ "acme-llm": acmeProvider }),
      new Set([anthropicRef.id]),
      2 // every 2nd apply is rate-limited
    );
    mockGetClient.mockReturnValue(oc.client);
    const onChangeApplied = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), { onChangeApplied });
    for (let i = 0; i < 50 && getPendingConfigPushCount() > 0; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(getPendingConfigPushCount()).toBe(0);
    expect(oc.providers()).not.toHaveProperty("acme-llm");
    expect(configFileWrites()).toHaveLength(0);
    expect(onChangeApplied).toHaveBeenCalledTimes(1);
  });

  it("does not step a kept provider's catalogue collapse past OpenClaw (Ollama unreachable at boot)", async () => {
    // Discovery against an unreachable Ollama returns [] (uncached), and the
    // regenerate emits `ollama` with `models: []`. OpenClaw refuses that as a
    // size drop — rightly: delivering it promotes an empty catalogue to
    // last-known-good, and on an offline install every agent then fails with
    // "Unknown model". Ollama is still in the payload, so this is a failed
    // read, not a deletion, and stepping must not explain it away.
    const ollama = {
      baseUrl: "http://host.docker.internal:11434/v1",
      api: "openai-completions",
      request: { allowPrivateNetwork: true },
      models: Array.from({ length: 40 }, (_, i) => model(i)),
    };
    const oc = new FakeOpenClaw(pinchyConfig({ ollama }), new Set([anthropicRef.id]));
    mockGetClient.mockReturnValue(oc.client);
    const before = oc.file;
    const onChangeApplied = vi.fn();
    const resume = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig({ ollama: { ...ollama, models: [] } })), {
      onChangeApplied,
      fullRegenerate: true,
      resumeStrandedShrink: resume,
    });
    await settle();

    expect(oc.rejections).toHaveLength(1);
    expect(oc.accepted).toHaveLength(0);
    expect(oc.file).toBe(before);
    expect(configFileWrites()).toHaveLength(0);
    expect(onChangeApplied).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/size-drop/);
    // Nothing was stepped, so nothing is stranded — no follow-up.
    expect(resume).not.toHaveBeenCalled();
  });

  it("stops before applying a step past its budget, and queues one follow-up regenerate", async () => {
    // A shrink so large that eight halving steps cannot reach the target. The
    // budget must be checked BEFORE a step is applied: applying the ninth and
    // then giving up leaves OpenClaw one step further for nothing. Either way
    // OpenClaw is now on an intermediate step, so the push hands off to a full
    // regenerate, which steps on from there.
    vi.useFakeTimers();
    const huge = {
      ...acmeProvider,
      models: Array.from({ length: 4000 }, (_, i) => model(i)),
    };
    const oc = new FakeOpenClaw(pinchyConfig({ "acme-llm": huge }), new Set([anthropicRef.id]));
    mockGetClient.mockReturnValue(oc.client);
    const resume = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), {
      fullRegenerate: true,
      resumeStrandedShrink: resume,
    });
    await drainWithFakeTimers();

    expect(oc.providers(), "precondition: 8 steps cannot finish this shrink").toHaveProperty(
      "acme-llm"
    );
    expect(oc.accepted.length).toBeGreaterThan(0);
    expect(oc.accepted.length).toBeLessThanOrEqual(8);
    expect(configFileWrites()).toHaveLength(0);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/8 steps/);
    expect(resume).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("queues one follow-up regenerate when a targeted write supersedes an unfinished stepped delivery", async () => {
    // updateTelegramChannelConfig reads openclaw.json — mid-shrink, that is an
    // intermediate step carrying the deleted provider's stub — and pushes it
    // with one channel changed, bumping the push generation. The stepping push
    // is superseded and OpenClaw stays on the stub config. A full regenerate
    // must follow, or the deletion never completes.
    vi.useFakeTimers();
    const oc = new FakeOpenClaw(
      pinchyConfig({ "acme-llm": acmeProvider }),
      new Set([anthropicRef.id])
    );
    mockGetClient.mockReturnValue(oc.client);
    const resume = vi.fn();
    oc.onAccepted = (n) => {
      if (n !== 1) return;
      const onDisk = JSON.parse(oc.file) as Json;
      pushConfigInBackground(
        serialize({ ...onDisk, channels: { telegram: { enabled: true, dmPolicy: "pairing" } } })
      );
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), {
      fullRegenerate: true,
      resumeStrandedShrink: resume,
    });
    await drainWithFakeTimers();

    expect(oc.providers(), "precondition: the targeted write stranded the stub").toHaveProperty(
      "acme-llm"
    );
    expect(JSON.parse(oc.file).channels).toEqual({
      telegram: { enabled: true, dmPolicy: "pairing" },
    });
    expect(resume).toHaveBeenCalledTimes(1);
    // Owed to OpenClaw's next connect too, should the follow-up be stranded.
    expect(undeliveredConfigChange()).toBe(true);
  });

  it("runs no follow-up when a full regenerate supersedes the stepped delivery and delivers the target itself", async () => {
    vi.useFakeTimers();
    const oc = new FakeOpenClaw(
      pinchyConfig({ "acme-llm": acmeProvider }),
      new Set([anthropicRef.id])
    );
    mockGetClient.mockReturnValue(oc.client);
    const firstResume = vi.fn();
    const secondResume = vi.fn();
    oc.onAccepted = (n) => {
      if (n !== 1) return;
      pushConfigInBackground(serialize(pinchyConfig()), {
        fullRegenerate: true,
        resumeStrandedShrink: secondResume,
      });
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), {
      fullRegenerate: true,
      resumeStrandedShrink: firstResume,
    });
    await drainWithFakeTimers();

    expect(oc.providers()).not.toHaveProperty("acme-llm");
    expect(firstResume).not.toHaveBeenCalled();
    expect(secondResume).not.toHaveBeenCalled();
    expect(undeliveredConfigChange(), "the later regenerate delivered it").toBe(false);
  });

  // OpenClaw checks its control-plane rate limit (~3 applies per window) BEFORE
  // the size check. A deletion whose every apply is rate-limited never sees
  // the size-drop refusal that used to be the only shrink signal, ran out its
  // rate-limit budget and fell back to writing the shrunken file directly —
  // past OpenClaw's guard, and restored from .bak on OpenClaw's next start.
  // regenerateOpenClawConfig knows the shrink up front (its own guard just
  // discounted the deleted provider), and says so.
  it("never writes the file when a provider deletion is rate-limited before OpenClaw's first refusal, and queues one follow-up", async () => {
    vi.useFakeTimers();
    const oc = new FakeOpenClaw(
      pinchyConfig({ "acme-llm": acmeProvider }),
      new Set([anthropicRef.id])
    );
    oc.rateLimitWhen = () => true;
    mockGetClient.mockReturnValue(oc.client);
    const before = oc.file;
    const onChangeApplied = vi.fn();
    const resume = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), {
      onChangeApplied,
      fullRegenerate: true,
      expectsProviderShrink: true,
      resumeStrandedShrink: resume,
    });
    await drainWithFakeTimers();

    expect(oc.applies.length, "precondition: the push did try").toBeGreaterThan(0);
    expect(oc.rejections, "precondition: OpenClaw never got to its size check").toHaveLength(0);
    expect(configFileWrites()).toHaveLength(0);
    expect(oc.file).toBe(before);
    expect(onChangeApplied).not.toHaveBeenCalled();
    // OpenClaw is unchanged, but the drop was transient — try once more.
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("never writes the file when a provider deletion cannot reach a connected OpenClaw, and queues one follow-up", async () => {
    vi.useFakeTimers();
    const notConnected = () => Promise.reject(new Error("Not connected to OpenClaw Gateway"));
    const client = { config: { get: vi.fn(notConnected), apply: vi.fn(notConnected) } };
    mockGetClient.mockReturnValue(client);
    const onChangeApplied = vi.fn();
    const resume = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), {
      onChangeApplied,
      fullRegenerate: true,
      expectsProviderShrink: true,
      resumeStrandedShrink: resume,
    });
    await drainWithFakeTimers();

    expect(client.config.get, "precondition: the push did retry").toHaveBeenCalled();
    expect(configFileWrites()).toHaveLength(0);
    expect(onChangeApplied).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("owes a provider deletion that cannot reach OpenClaw to its reconnect, even from the follow-up", async () => {
    // The follow-up regenerate passes no follow-up of its own, so when OpenClaw
    // stays down past it, nothing else in the push would retry. OpenClaw's
    // reconnect does (regenerateOnConnect), because the push records that it
    // gave up.
    vi.useFakeTimers();
    const notConnected = () => Promise.reject(new Error("Not connected to OpenClaw Gateway"));
    mockGetClient.mockReturnValue({
      config: { get: vi.fn(notConnected), apply: vi.fn(notConnected) },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), {
      fullRegenerate: true,
      regenerateSeq: nextRegenerateSequence(),
      expectsProviderShrink: true,
    });
    await drainWithFakeTimers();

    expect(configFileWrites()).toHaveLength(0);
    expect(undeliveredConfigChange()).toBe(true);
  });

  it("never writes the file for a provider deletion when Pinchy has no OpenClaw client yet (boot)", async () => {
    // bootInits regenerates before the client exists. Writing the shrunken
    // file there bypasses OpenClaw's guard just like any other fallback — and
    // OpenClaw's read path restores `.bak` over it, which still names the
    // deleted provider's key. The first-connect regenerate delivers it in steps.
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });
    const onChangeApplied = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), {
      onChangeApplied,
      fullRegenerate: true,
      expectsProviderShrink: true,
    });
    await settle();

    expect(configFileWrites()).toHaveLength(0);
    expect(onChangeApplied).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/NOT writing openclaw.json/);
  });

  it("queues a follow-up when OpenClaw calibrated the shrink but rate-limited every step (none landed)", async () => {
    // The refusal arrived, so the push knows the shrink — but OpenClaw then
    // rate-limits every step until the budget runs out. Nothing was stepped,
    // and the drop is transient: the deletion still has to reach OpenClaw.
    vi.useFakeTimers();
    const oc = new FakeOpenClaw(
      pinchyConfig({ "acme-llm": acmeProvider }),
      new Set([anthropicRef.id])
    );
    oc.rateLimitWhen = (n) => n > 1;
    mockGetClient.mockReturnValue(oc.client);
    const resume = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), {
      fullRegenerate: true,
      resumeStrandedShrink: resume,
    });
    await drainWithFakeTimers();

    expect(oc.rejections, "precondition: calibrated from one refusal").toHaveLength(1);
    expect(oc.accepted, "precondition: no step landed").toHaveLength(0);
    expect(configFileWrites()).toHaveLength(0);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("keeps a queued follow-up when a full regenerate that STARTED before the stranded one delivers after it", async () => {
    // R0 started before the provider row was deleted (a slow discovery, say)
    // and still contains the provider. R1 started after, carries the deletion,
    // and strands: a targeted write supersedes it after one step. R0 then
    // reaches OpenClaw last. Push order says "the newest full regenerate
    // landed"; read order says R0 never saw the deletion. Cancelling R1's
    // follow-up on R0's delivery would leave the deleted provider live.
    vi.useFakeTimers();
    const oc = new FakeOpenClaw(
      pinchyConfig({ "acme-llm": acmeProvider }),
      new Set([anthropicRef.id, acmeRef.id])
    );
    mockGetClient.mockReturnValue(oc.client);
    const r0Seq = nextRegenerateSequence();
    const r1Seq = nextRegenerateSequence();
    oc.onAccepted = (n) => {
      if (n !== 1) return;
      pushConfigInBackground(
        serialize({ ...(JSON.parse(oc.file) as Json), channels: { telegram: { enabled: true } } })
      );
    };
    const resumeR1 = vi.fn();
    const resumeR0 = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), {
      fullRegenerate: true,
      regenerateSeq: r1Seq,
      resumeStrandedShrink: resumeR1,
    });
    for (let i = 0; i < 100 && getPendingConfigPushCount() > 0; i++) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(getPendingConfigPushCount()).toBe(0);
    expect(resumeR1, "precondition: R1's follow-up is pending").not.toHaveBeenCalled();
    oc.onAccepted = undefined;

    // R0's payload: everything as it was before the deletion.
    pushConfigInBackground(
      serialize({
        ...pinchyConfig({ "acme-llm": acmeProvider }),
        channels: { telegram: { enabled: true } },
      }),
      { fullRegenerate: true, regenerateSeq: r0Seq, resumeStrandedShrink: resumeR0 }
    );
    await drainWithFakeTimers();

    expect(oc.providers(), "precondition: R0 put the provider back").toHaveProperty("acme-llm");
    expect(resumeR1).toHaveBeenCalledTimes(1);
  });

  it("keeps a queued follow-up when the full regenerate that would have finished it is superseded by a partial write", async () => {
    // A strands (a targeted write supersedes it after step 1) and queues a
    // follow-up. Then a full regenerate B starts — and a targeted write
    // supersedes B before B delivers anything. B starting must not have
    // cancelled A's follow-up: only a full regenerate that REACHES OpenClaw
    // makes it moot. Otherwise the stub is stranded for good.
    vi.useFakeTimers();
    const oc = new FakeOpenClaw(
      pinchyConfig({ "acme-llm": acmeProvider }),
      new Set([anthropicRef.id])
    );
    mockGetClient.mockReturnValue(oc.client);
    const withTelegram = (enabled: boolean) =>
      serialize({ ...(JSON.parse(oc.file) as Json), channels: { telegram: { enabled } } });
    oc.onAccepted = (n) => {
      if (n === 1) pushConfigInBackground(withTelegram(true));
    };
    const resumeA = vi.fn();
    const resumeB = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    pushConfigInBackground(serialize(pinchyConfig()), {
      fullRegenerate: true,
      resumeStrandedShrink: resumeA,
    });
    // Settle A and the targeted write, well inside the follow-up's debounce.
    for (let i = 0; i < 100 && getPendingConfigPushCount() > 0; i++) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(getPendingConfigPushCount()).toBe(0);
    expect(resumeA, "precondition: the follow-up is still pending").not.toHaveBeenCalled();
    oc.onAccepted = undefined;

    pushConfigInBackground(serialize(pinchyConfig()), {
      fullRegenerate: true,
      resumeStrandedShrink: resumeB,
    });
    pushConfigInBackground(withTelegram(false));
    await drainWithFakeTimers();

    expect(oc.providers(), "precondition: OpenClaw is still on the stub").toHaveProperty(
      "acme-llm"
    );
    expect(resumeA.mock.calls.length + resumeB.mock.calls.length).toBe(1);
  });
});
