// Every Pinchy write of openclaw.json is judged against the largest file
// OpenClaw may still hold as last-known-good — not only against the file on
// disk (last-good-bound.ts). OpenClaw promotes last-known-good only while it
// runs, so while it is down the file from before the first Pinchy write stays
// its baseline however much later writes shrank the disk. Real files in a
// temp dir: the bound has to survive a Pinchy restart through one.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mockGetClient = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

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
    };
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
