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
import { getPendingConfigPushCount, _resetConfigPushState } from "@/lib/openclaw-config/push-state";

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
        if (this.rateLimitEvery && this.applies.length % this.rateLimitEvery === 0) {
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
});
