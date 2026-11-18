/**
 * Before the setup wizard runs, the only `openclaw.json` OpenClaw ever sees is
 * the boot seed (`seedRestartClassOverridesIfMissing`): no providers, no
 * agents. The full config — `plugins.allow` with every Pinchy plugin and its
 * `config` — arrives with the wizard's first regenerate.
 *
 * Pinchy installs its plugins globally (`sync-plugins.sh` copies every
 * `pinchy-*` into `~/.openclaw/extensions`). OpenClaw 2026.9 enables a global
 * plugin when no allow-list says otherwise and validates each enabled plugin's
 * config — `{}` before the wizard, which fails every required field
 * (`apiBaseUrl`, `gatewayToken`, `agents`, `docsPath`). It does so as soon as
 * the file has a `plugins` block, and since 2026.9 the seed writes one (the
 * canvas host moved into `plugins.entries.canvas`). The gateway refuses to
 * start on that, so a fresh install never reached the wizard: every E2E suite
 * and the Docker smoke test went red on the 2026.9.2 bump.
 *
 * This loads the seeded file through OpenClaw's own loader with the real
 * plugin packages installed where the image puts them. Each load runs in a
 * fresh process: OpenClaw resolves its state directory and caches the loaded
 * config per process, so a second load in the same one proves nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

const WEB_DIR = resolve(__dirname, "../../..");
const PLUGINS_DIR = resolve(WEB_DIR, "../plugins");

function installPinchyPluginsGlobally(stateDir: string): string[] {
  const extensions = join(stateDir, "extensions");
  mkdirSync(extensions, { recursive: true });
  const ids = readdirSync(PLUGINS_DIR).filter((name) => name.startsWith("pinchy-"));
  for (const id of ids) {
    cpSync(join(PLUGINS_DIR, id), join(extensions, id), {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|__tests__)([\\/]|$)/.test(src),
    });
  }
  return ids;
}

/** Runs OpenClaw's `loadConfig()` in a fresh process; returns its error, or null. */
function loadConfigError(stateDir: string, configPath: string): string | null {
  try {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { loadConfig } = await import("openclaw"); loadConfig();',
      ],
      {
        cwd: WEB_DIR,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        stdio: "pipe",
        timeout: 60_000,
      }
    );
    return null;
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    return e.stderr?.toString() || e.message;
  }
}

describe("the boot seed loads under OpenClaw with Pinchy's plugins installed", () => {
  let stateDir: string;
  let configPath: string;
  let pluginIds: string[];
  const savedConfigPath = process.env.OPENCLAW_CONFIG_PATH;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "pinchy-oc-state-"));
    pluginIds = installPinchyPluginsGlobally(stateDir);
    configPath = join(stateDir, "openclaw.json");
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    // entrypoint.sh's seed for an empty volume.
    writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local", bind: "lan" } }));
    vi.resetModules();
  });

  afterEach(() => {
    if (savedConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = savedConfigPath;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("seeds a file that loads without enabling a Pinchy plugin", async () => {
    const { seedRestartClassOverridesIfMissing } = await import("@/lib/openclaw-config");
    expect(seedRestartClassOverridesIfMissing()).toBe(true);

    expect(loadConfigError(stateDir, configPath)).toBeNull();
  }, 60_000);

  it("baseline: the same file without its allow-list is rejected", async () => {
    // Proves the test above exercises the failure, not an environment in which
    // OpenClaw never looks at the extensions directory.
    expect(pluginIds).toEqual(expect.arrayContaining(["pinchy-docs", "pinchy-approvals"]));
    const { seedRestartClassOverridesIfMissing } = await import("@/lib/openclaw-config");
    seedRestartClassOverridesIfMissing();
    const seeded = JSON.parse(readFileSync(configPath, "utf-8"));
    delete seeded.plugins.allow;
    writeFileSync(configPath, JSON.stringify(seeded));

    expect(loadConfigError(stateDir, configPath)).toMatch(/plugins\.entries\.pinchy-docs\.config/);
  }, 60_000);
});
