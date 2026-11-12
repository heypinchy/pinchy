/**
 * Dropping an agent from OpenClaw's roster must reach OpenClaw through its OWN
 * gateway handlers — the real `config.get`, `config.apply` and `agents.delete`.
 *
 * OpenClaw 2026.9 refuses any config write that drops an agent from its roster
 * ("Config write would drop agent roster entries without an explicit
 * deletion: <ids>"), and config.apply takes no parameter that lifts the check.
 * Pinchy replaces the roster wholesale, so two everyday changes reach OpenClaw
 * as such a write:
 *
 *   - a fresh install's first agent: the image's openclaw.json has no roster,
 *     which OpenClaw reads as holding the implicit "main" agent;
 *   - deleting an agent.
 *
 * push-roster-removal.test.ts covers the push logic against a fake; this file
 * proves the fake's reading of OpenClaw's rules holds for the pinned version:
 * the refusal text, the implicit "main" and agents.delete's refusal of it,
 * of the sole agent and of the agent others inherit auth from. Pinchy writes
 * openclaw.json itself only to retire that placeholder "main".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  gatewayRequest,
  loadGatewayHandlers,
  releaseGatewayWrites,
} from "@/test-helpers/openclaw-gateway-handlers";
import { parseRosterDropRejection } from "@/lib/openclaw-config/roster-removal";

const mockGetClient = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

type Json = Record<string, unknown>;

/** The openclaw.json the pinchy-openclaw image ships (Dockerfile.openclaw copies it). */
const IMAGE_SEED = JSON.parse(
  readFileSync(join(__dirname, "../../../../../config/openclaw.json"), "utf-8")
) as Json;

const gateway = {
  ...(IMAGE_SEED.gateway as Json),
  auth: { mode: "token", token: "t".repeat(40) },
};

describe("a roster change against OpenClaw's real config.apply and agents.delete", () => {
  let dir: string;
  let ocConfigPath: string;
  let pinchyConfigPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-roster-"));
    ocConfigPath = join(dir, "openclaw.json");
    pinchyConfigPath = join(dir, "pinchy-must-not-write.json");
    process.env.OPENCLAW_STATE_DIR = dir;
    vi.resetModules();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    releaseGatewayWrites();
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * Pinchy's push, its client answered by the real handlers; resolves once it
   * settled. `writesFile`: the push may write OpenClaw's openclaw.json itself
   * (retiring the placeholder main); otherwise Pinchy is pointed at a path
   * nothing may write.
   */
  async function push(target: Json, { writesFile = false } = {}) {
    // Pinchy's module captures CONFIG_PATH at import; OpenClaw resolves the env
    // on every call.
    process.env.OPENCLAW_CONFIG_PATH = writesFile ? ocConfigPath : pinchyConfigPath;
    const { pushConfigInBackground } = await import("@/lib/openclaw-config/write");
    const { getPendingConfigPushCount } = await import("@/lib/openclaw-config/push-state");
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    const handlers = await loadGatewayHandlers();
    const request = (method: string, params: Json) => gatewayRequest(handlers[method], params);
    const deletes: Json[] = [];
    mockGetClient.mockReturnValue({
      config: {
        get: () => request("config.get", {}),
        apply: (raw: string, baseHash?: string, options: Json = {}) =>
          request("config.apply", { raw, ...(baseHash ? { baseHash } : {}), ...options }),
      },
      request: (method: string, params: Json) => {
        if (method === "agents.delete") deletes.push(params);
        return request(method, params);
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onChangeApplied = vi.fn();

    pushConfigInBackground(JSON.stringify(target, null, 2), { onChangeApplied });
    for (let i = 0; i < 2000 && getPendingConfigPushCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(getPendingConfigPushCount(), "push never settled").toBe(0);
    expect(errorSpy.mock.calls.flat().join(" ")).toBe("");
    expect(onChangeApplied).toHaveBeenCalledTimes(1);
    expect(existsSync(pinchyConfigPath), "Pinchy must not write openclaw.json itself").toBe(false);
    return { request, deletes };
  }

  /** openclaw.json as OpenClaw itself writes it — its own onboarding drops the implicit main. */
  async function ocWrites(config: Json) {
    const { writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    await writeConfigFile(config as Parameters<typeof writeConfigFile>[0], {
      allowedAgentRosterRemovals: ["main"],
    });
  }

  const ocFile = () => JSON.parse(readFileSync(ocConfigPath, "utf-8")) as Json;
  const roster = (config: Json) =>
    Object.keys(((config.agents as Json | undefined)?.entries ?? {}) as Json).sort();

  it("delivers a fresh install's first agent, retiring the placeholder main by a file write", async () => {
    writeFileSync(ocConfigPath, JSON.stringify({ ...IMAGE_SEED, gateway }, null, 2));
    const target = {
      ...IMAGE_SEED,
      gateway,
      agents: { entries: { smithers: { name: "Smithers" } } },
    };

    // The premise: OpenClaw refuses the first agent as a single write.
    process.env.OPENCLAW_CONFIG_PATH = ocConfigPath;
    const handlers = await loadGatewayHandlers();
    const snapshot = await gatewayRequest(handlers["config.get"], {});
    const refusal = await gatewayRequest(handlers["config.apply"], {
      raw: JSON.stringify(target, null, 2),
      baseHash: snapshot.hash,
    }).then(
      () => "accepted",
      (err: Error) => err.message
    );
    expect(parseRosterDropRejection(refusal)).toEqual(["main"]);
    // …and agents.delete refuses the placeholder: on a Pinchy install it owns
    // OpenClaw's legacy shared auth store.
    const deleteRefusal = await gatewayRequest(handlers["agents.delete"], {
      agentId: "main",
      deleteFiles: false,
    }).then(
      () => "deleted",
      (err: Error) => err.message
    );
    expect(deleteRefusal).toMatch(/cannot be deleted/);
    releaseGatewayWrites();

    const { deletes } = await push(target, { writesFile: true });

    expect(roster(ocFile())).toEqual(["smithers"]);
    expect(deletes).toEqual([]);

    // OpenClaw holds the roster exactly as Pinchy sent it: nothing it stamped
    // while taking the change (an authInheritance owner, say) would make every
    // later push differ from its runtime.
    expect(ocFile().agents).toEqual(target.agents);
  }, 60_000);

  it("removes a deleted agent through agents.delete", async () => {
    const before = {
      ...IMAGE_SEED,
      gateway,
      agents: {
        ownership: "explicit",
        entries: { smithers: { name: "Smithers" }, kb: { name: "Handbook" } },
      },
    };
    await ocWrites(before);
    const target = {
      ...before,
      agents: { ownership: "explicit", entries: { smithers: { name: "Smithers" } } },
    };

    const { deletes } = await push(target);

    expect(roster(ocFile())).toEqual(["smithers"]);
    expect(deletes).toEqual([{ agentId: "kb", deleteFiles: false }]);
    expect(ocFile().agents).toEqual(target.agents);
  }, 60_000);

  /** A fresh install's openclaw.json after Pinchy delivered its first agent. */
  async function installedWith(first: Json) {
    writeFileSync(ocConfigPath, JSON.stringify({ ...IMAGE_SEED, gateway }, null, 2));
    await push({ ...IMAGE_SEED, gateway, agents: { entries: first } }, { writesFile: true });
    releaseGatewayWrites();
  }

  it("removes the agent the others inherit auth from", async () => {
    // smithers, the first agent, is the one the others inherit auth from
    // (OpenClaw's compatibility agent), which agents.delete refuses unless the
    // role moves to an agent that stays.
    await installedWith({ smithers: { name: "Smithers" } });
    const both = {
      ...IMAGE_SEED,
      gateway,
      agents: {
        ownership: "explicit",
        entries: { smithers: { name: "Smithers" }, kb: { name: "Handbook" } },
      },
    };
    await push(both);
    releaseGatewayWrites();
    const target = {
      ...both,
      agents: { ownership: "explicit", entries: { kb: { name: "Handbook" } } },
    };

    const { deletes } = await push(target);

    expect(roster(ocFile())).toEqual(["kb"]);
    expect(deletes).toEqual([{ agentId: "smithers", deleteFiles: false }]);
    expect(ocFile().agents).toEqual(target.agents);
  }, 60_000);

  it("replaces a sole agent", async () => {
    await installedWith({ smithers: { name: "Smithers" } });
    const target = { ...IMAGE_SEED, gateway, agents: { entries: { kb: { name: "Handbook" } } } };

    const { deletes } = await push(target);

    expect(roster(ocFile())).toEqual(["kb"]);
    // Two rounds: the bridge grows the roster past one agent, and OpenClaw
    // then hands the roles the sole agent held to it by name — authInheritance
    // included, over the bridge's own (materializeLegacyDefaultAgentRoles), so
    // the first agents.delete is refused. The next round's bridge changes no
    // roster, so OpenClaw takes its authInheritance and the delete goes through.
    expect(deletes).toEqual([
      { agentId: "smithers", deleteFiles: false },
      { agentId: "smithers", deleteFiles: false },
    ]);
    expect(ocFile().agents).toEqual(target.agents);
  }, 60_000);
});
