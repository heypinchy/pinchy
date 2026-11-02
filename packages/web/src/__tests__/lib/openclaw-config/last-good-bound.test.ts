// Every Pinchy write of openclaw.json is judged against the largest file
// OpenClaw may still hold as last-known-good — not only against the file on
// disk (last-good-bound.ts). OpenClaw promotes last-known-good only while it
// runs, so while it is down the file from before the first Pinchy write stays
// its baseline however much later writes shrank the disk. Real files in a
// temp dir: the bound has to survive a Pinchy restart through one.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const mockGetClient = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));
vi.mock("@/server/restart-state", () => ({ restartState: { notifyRestart: vi.fn() } }));
vi.mock("@/lib/gateway-token-source", () => ({ getOrCreateGatewayToken: vi.fn() }));

type Json = Record<string, unknown>;

/** A pretty-printed config of roughly `kb` kilobytes. */
function configOf(kb: number): string {
  const models = Array.from({ length: Math.round(kb * 5) }, (_, i) => ({
    id: `model-${i}-with-a-realistically-long-identifier`,
    name: `Model ${i} (display)`,
  }));
  const config: Json = {
    gateway: { mode: "local", bind: "lan", auth: { mode: "token", token: "t".repeat(40) } },
    models: { providers: { acme: { baseUrl: "https://acme.example/v1", models } } },
  };
  return JSON.stringify(config, null, 2).trimEnd() + "\n";
}

const bytes = (s: string) => Buffer.byteLength(s, "utf-8");

/** configOf(kb) with `bots` Telegram bots connected, the way Pinchy writes them. */
function withBots(kb: number, bots: number): string {
  const config = JSON.parse(configOf(kb)) as Json;
  const ids = Array.from({ length: bots }, (_, i) => `agent-${i}-0000-0000-0000-000000000000`);
  config.channels = {
    telegram: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: Object.fromEntries(
        ids.map((id) => [id, { botToken: `12345678${String(bots)}:AAH${"x".repeat(32)}` }])
      ),
    },
  };
  config.bindings = ids.map((id) => ({
    agentId: id,
    match: { channel: "telegram", accountId: id },
  }));
  return JSON.stringify(config, null, 2).trimEnd() + "\n";
}

describe("Pinchy's file writes against OpenClaw's last-known-good", () => {
  let dir: string;
  let configPath: string;

  /** Pinchy as a (re)started process loads it: only the disk survives. */
  async function startPinchy() {
    vi.resetModules();
    (globalThis as { __pinchyConfigPushState?: unknown }).__pinchyConfigPushState = undefined;
    return {
      ...(await import("@/lib/openclaw-config/write")),
      ...(await import("@/lib/openclaw-config/last-good-bound")),
      ...(await import("@/lib/openclaw-config/push-state")),
      ...(await import("@/lib/openclaw-config/targeted")),
      ...(await import("@/server/openclaw-connect-regenerate")),
    };
  }
  type Pinchy = Awaited<ReturnType<typeof startPinchy>>;

  async function settle(pinchy: Pinchy) {
    for (let i = 0; i < 200 && pinchy.getPendingConfigPushCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(pinchy.getPendingConfigPushCount()).toBe(0);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-last-good-"));
    configPath = join(dir, "openclaw.json");
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    (globalThis as { __pinchyConfigPushState?: unknown }).__pinchyConfigPushState = undefined;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("refuses a write under half of a file an earlier write replaced, though it is over half of the disk", async () => {
    const pinchy = await startPinchy();
    const installed = configOf(20);
    writeFileSync(configPath, installed);
    const shrunk = configOf(12);
    pinchy.writeConfigAtomic(shrunk);
    const smaller = configOf(8);
    expect(bytes(smaller), "precondition: over half of the disk").toBeGreaterThanOrEqual(
      bytes(shrunk) / 2
    );

    expect(() => pinchy.writeConfigAtomic(smaller)).toThrow(pinchy.UnderReadSideLineError);
    expect(readFileSync(configPath, "utf-8")).toBe(shrunk);
  });

  it("remembers that file across a Pinchy restart", async () => {
    let pinchy = await startPinchy();
    writeFileSync(configPath, configOf(20));
    pinchy.writeConfigAtomic(configOf(12));

    pinchy = await startPinchy();
    expect(() => pinchy.writeConfigAtomic(configOf(8))).toThrow(pinchy.UnderReadSideLineError);
    expect(readFileSync(configPath, "utf-8")).toBe(configOf(12));
  });

  it("keeps no file of its own while the disk says as much", async () => {
    const pinchy = await startPinchy();
    writeFileSync(configPath, configOf(10));
    pinchy.writeConfigAtomic(configOf(12));
    pinchy.writeConfigAtomic(configOf(12));
    expect(existsSync(pinchy.LAST_GOOD_BOUND_PATH)).toBe(false);
  });

  it("ignores a bound file it cannot parse", async () => {
    let pinchy = await startPinchy();
    writeFileSync(configPath, configOf(12));
    writeFileSync(pinchy.LAST_GOOD_BOUND_PATH, "{ not json");
    pinchy = await startPinchy();
    expect(() => pinchy.writeConfigAtomic(configOf(8))).not.toThrow();
  });

  it("forgets it once a config.apply lands — OpenClaw is running and promotes its own write", async () => {
    let pinchy = await startPinchy();
    writeFileSync(configPath, configOf(20));
    pinchy.writeConfigAtomic(configOf(12));
    expect(existsSync(pinchy.LAST_GOOD_BOUND_PATH), "precondition: recorded").toBe(true);

    pinchy = await startPinchy();
    mockGetClient.mockReturnValue({
      config: {
        get: vi.fn(async () => ({ hash: "h", config: {} })),
        apply: vi.fn(async (payload: string) => writeFileSync(configPath, payload)),
      },
    });
    pinchy.pushConfigInBackground(configOf(12).replace("acme.example", "acme2.example"));
    for (let i = 0; i < 200 && pinchy.getPendingConfigPushCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(pinchy.getPendingConfigPushCount()).toBe(0);

    expect(existsSync(pinchy.LAST_GOOD_BOUND_PATH)).toBe(false);
    pinchy = await startPinchy();
    expect(() => pinchy.writeConfigAtomic(configOf(8))).not.toThrow();
  });

  // "Remove Telegram for everyone" while OpenClaw is down, on a file an
  // earlier write left just above OpenClaw's read-side line (a refused
  // re-key does that). The bots' block is what keeps it above: the targeted
  // write is refused, and the database no longer has the tokens. Before this
  // was owed to the reconnect, nothing resent it — a reconnect ran no
  // regenerate — and the bots resumed polling as soon as OpenClaw came back.
  it("delivers a Telegram removal refused under the line with the regenerate OpenClaw's reconnect runs", async () => {
    const pinchy = await startPinchy();
    const installed = withBots(20, 6);
    const line = Math.floor(bytes(installed) * 0.5);
    const kb = Array.from({ length: 100 }, (_, i) => 20 - i * 0.2).find(
      (k) => bytes(withBots(k, 6)) >= line && bytes(configOf(k)) < line
    );
    expect(kb, "precondition: a file the bots keep above the line").toBeDefined();
    writeFileSync(configPath, installed);
    pinchy.writeConfigAtomic(withBots(kb!, 6));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // OpenClaw is down.
    mockGetClient.mockReturnValue(undefined);
    expect(pinchy.updateTelegramChannelConfig(null, null)).toBe("applied");
    await settle(pinchy);
    expect(readFileSync(configPath, "utf-8"), "precondition: refused").toBe(withBots(kb!, 6));
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/last-known-good/);

    // OpenClaw comes back. Pinchy connected before it went down, so this is
    // a reconnect, not a first connect.
    const apply = vi.fn(async (raw: string) => writeFileSync(configPath, raw));
    mockGetClient.mockReturnValue({
      config: {
        get: vi.fn(async () => ({
          hash: "h",
          config: JSON.parse(readFileSync(configPath, "utf-8")) as Json,
        })),
        apply,
      },
    });
    // What regenerateOpenClawConfig pushes: the whole config rebuilt from the
    // database, where the bots are gone.
    const regenerate = vi.fn(() => {
      pinchy.pushConfigInBackground(configOf(kb!), {
        fullRegenerate: true,
        regenerateSeq: pinchy.nextRegenerateSequence(),
      });
      return Promise.resolve();
    });
    pinchy.regenerateOnConnect({ firstConnect: false }, regenerate);
    await settle(pinchy);

    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    const landed = JSON.parse(readFileSync(configPath, "utf-8")) as Json;
    expect(landed.channels).toBeUndefined();
    expect(landed.bindings).toBeUndefined();

    // Delivered: the next reconnect owes nothing.
    pinchy.regenerateOnConnect({ firstConnect: false }, regenerate);
    expect(regenerate).toHaveBeenCalledTimes(1);
    pinchy._resetConfigPushState();
  });

  it("leaves the file to config.apply when a push without a client would write under the line", async () => {
    const pinchy = await startPinchy();
    writeFileSync(configPath, configOf(20));
    pinchy.writeConfigAtomic(configOf(12));
    mockGetClient.mockReturnValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resume = vi.fn();

    pinchy.pushConfigInBackground(configOf(8), { resumeStrandedShrink: resume });
    for (let i = 0; i < 200 && pinchy.getPendingConfigPushCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(readFileSync(configPath, "utf-8")).toBe(configOf(12));
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/last-known-good/);
    pinchy._resetConfigPushState();
  });
});

// The regenerate writes openclaw.json itself twice (the key-less bridge and
// the re-keyed entry), and either can fall under the line — a bound only ever
// errs high, and goes stale whenever OpenClaw promotes a Pinchy-written file
// with no config.apply landing since. A call that let UnderReadSideLineError
// escape aborted the regenerate before any push, on every later regenerate
// too. So build.ts writes the file through one function, which sends a refused
// write over config.apply instead.
describe("build.ts's own writes of openclaw.json", () => {
  const source = readFileSync(resolve(__dirname, "../../../lib/openclaw-config/build.ts"), "utf-8");

  it("all go through writeFileOrApply, which hands a refused write to config.apply", () => {
    const start = source.indexOf("\nfunction writeFileOrApply(");
    expect(start, "writeFileOrApply exists").toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    const helper = source.slice(start, end);
    expect(helper).toMatch(/instanceof UnderReadSideLineError/);
    expect(helper).toMatch(/pushConfigInBackground\(/);

    const calls = [...source.matchAll(/\bwriteConfigAtomic\(/g)].map((m) => m.index);
    expect(calls.length, "the corpus: build.ts writes the file").toBeGreaterThan(0);
    for (const at of calls) {
      expect(at > start && at < end, `writeConfigAtomic( at offset ${String(at)}`).toBe(true);
    }
  });
});
