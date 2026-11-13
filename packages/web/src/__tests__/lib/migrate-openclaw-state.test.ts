import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";

// config/migrate-openclaw-state.sh runs OpenClaw's one-time state migration on
// an install upgraded from OpenClaw < 2026.9 (Pinchy <= v0.10.x).
//
// OpenClaw 2026.9 moved session stores and workspace setup state into SQLite
// and made the import doctor-only: the gateway refuses to start while legacy
// state is on disk ("Legacy workspace setup state requires migration … run
// openclaw doctor --fix", "Legacy session store requires migration"), and
// nothing but `openclaw doctor --fix` imports it. Without this helper the
// container crash-loops on the first boot after the upgrade.
//
// Contract pinned here:
//   1. Detection mirrors the gateway's two fail-closed guards, and nothing
//      more: workspace setup state for a CONFIGURED agent's workspace
//      (assertNoUnmigratedWorkspaceState), and any legacy sessions.json store
//      (assertSessionStoreMigrationComplete). Legacy files of an agent no longer
//      in openclaw.json do not block the gateway and doctor leaves them, so they
//      must not trigger doctor — otherwise every boot pays for a doctor run.
//   2. Doctor runs against a throwaway COPY of openclaw.json
//      (OPENCLAW_CONFIG_PATH): openclaw.json is Pinchy-owned and regenerated
//      from the database, and doctor --fix also normalizes config. The real
//      file must come out byte-identical.
//   3. Fail open with a loud log line: a failed migration must not stop the
//      gateway start that reports the real error and keeps the restart loop
//      honest, but the operator needs the manual command.
//
// The `openclaw` binary is stubbed on PATH; it records argv and the env this
// helper hands it, and can simulate doctor's effects. The real doctor run
// against real v0.10.x state is exercised end to end by
// scripts/openclaw-state-upgrade/run.sh in CI's end-user-upgrade job.

const REPO_ROOT = resolve(__dirname, "../../../../..");
const SCRIPT = resolve(REPO_ROOT, "config/migrate-openclaw-state.sh");

let root: string;
let stateDir: string;
let binDir: string;
let callLog: string;

const CONFIG = (workspaces: Record<string, string>) =>
  JSON.stringify(
    {
      gateway: { mode: "local" },
      agents: {
        entries: Object.fromEntries(
          Object.entries(workspaces).map(([id, ws]) => [
            id,
            { name: id, workspace: ws, heartbeat: { every: "0m" } },
          ])
        ),
      },
    },
    null,
    2
  );

// A stub `openclaw` that logs one JSON line per call (argv, the config path it
// was pointed at, the state dir), optionally runs a shell snippet standing in
// for doctor's effects, and exits with the given code.
function stubOpenclaw(exitCode: number, effect = ""): void {
  const bin = join(binDir, "openclaw");
  writeFileSync(
    bin,
    `#!/bin/bash
node -e 'const fs=require("fs");fs.appendFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2), configPath: process.env.OPENCLAW_CONFIG_PATH || null, stateDir: process.env.OPENCLAW_STATE_DIR || null})+"\\n")' '${callLog}' "$@"
${effect}
exit ${exitCode}
`
  );
  chmodSync(bin, 0o755);
}

type Call = { argv: string[]; configPath: string | null; stateDir: string | null };
function calls(): Call[] {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Call);
}

// Runs under `set -e`, as start-openclaw.sh does: a command failing inside the
// helper must not abort the entrypoint, or "fails open" is a claim, not a fact.
// The trailing marker proves the caller kept going.
function run(fn: string): { status: number; output: string } {
  try {
    const script = `set -e; source '${SCRIPT}'; ${fn} 2>&1; echo CALLER-CONTINUED`;
    const output = execFileSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_MIGRATION_TIMEOUT: "30",
      },
      encoding: "utf8",
    });
    expect(output).toContain("CALLER-CONTINUED");
    return { status: 0, output };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { status: e.status, output: e.stdout };
  }
}

function writeConfig(workspaces: Record<string, string>): string {
  const text = CONFIG(workspaces);
  writeFileSync(join(stateDir, "openclaw.json"), text);
  return text;
}

function ws(id: string): string {
  const dir = join(stateDir, "workspaces", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "migrate-oc-state-"));
  stateDir = join(root, "state");
  binDir = join(root, "bin");
  callLog = join(root, "calls.jsonl");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  stubOpenclaw(0);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("migrate_legacy_openclaw_state", () => {
  it("does not run doctor on a fresh or already-migrated install", () => {
    const probe = ws("probe");
    writeConfig({ probe });
    // What a migrated install looks like: SQLite stores, archived originals.
    mkdirSync(join(stateDir, "agents", "probe", "agent"), { recursive: true });
    writeFileSync(join(stateDir, "agents", "probe", "agent", "openclaw-agent.sqlite"), "");
    mkdirSync(join(stateDir, "agents", "probe", "session-sqlite-import-archive"), {
      recursive: true,
    });
    writeFileSync(join(probe, "openclaw-workspace-state.json.migrated.abc.123"), "{}");

    const { status } = run("migrate_legacy_openclaw_state");

    expect(status).toBe(0);
    expect(calls()).toEqual([]);
  });

  it.each([
    ["the current setup-state file", (dir: string) => join(dir, "openclaw-workspace-state.json")],
    [
      "the older .openclaw/ setup-state file",
      (dir: string) => join(dir, ".openclaw", "workspace-state.json"),
    ],
    [
      "a doctor-import claim",
      (dir: string) => join(dir, "openclaw-workspace-state.json.doctor-importing"),
    ],
  ])("runs doctor when a configured workspace has %s", (_label, legacyPath) => {
    const probe = ws("probe");
    writeConfig({ probe });
    const file = legacyPath(probe);
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, "{}");

    run("migrate_legacy_openclaw_state");

    expect(calls().map((c) => c.argv)).toEqual([["doctor", "--fix", "--non-interactive"]]);
  });

  it("runs doctor for a sibling attestation OpenClaw wrote, and ignores a foreign one", () => {
    // The gateway counts <workspace>.attested only when it is a regular file
    // starting with OpenClaw's header; anything else must not re-run doctor on
    // every boot.
    const probe = ws("probe");
    writeConfig({ probe });
    writeFileSync(`${probe}.attested`, "something else entirely\n");

    run("migrate_legacy_openclaw_state");
    expect(calls()).toEqual([]);

    writeFileSync(`${probe}.attested`, "openclaw-workspace-attestation:v1\n2026-01-01\n");
    run("migrate_legacy_openclaw_state");
    expect(calls()).toHaveLength(1);
  });

  it("runs doctor for a state-dir attestation keyed by the workspace path's sha256", () => {
    const probe = ws("probe");
    writeConfig({ probe });
    const key = createHash("sha256").update(probe).digest("hex");
    mkdirSync(join(stateDir, "workspace-attestations"), { recursive: true });
    writeFileSync(join(stateDir, "workspace-attestations", `${key}.attested`), "x");

    run("migrate_legacy_openclaw_state");

    expect(calls()).toHaveLength(1);
  });

  it("reads workspaces from agents.list as well as agents.entries", () => {
    const probe = ws("probe");
    writeFileSync(
      join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "probe", workspace: probe }] } })
    );
    writeFileSync(join(probe, "openclaw-workspace-state.json"), "{}");

    run("migrate_legacy_openclaw_state");

    expect(calls()).toHaveLength(1);
  });

  it("ignores workspace state of an agent that is no longer configured", () => {
    // Doctor only migrates configured workspaces and the gateway only checks
    // those, so a deleted agent's leftover file would otherwise re-run doctor
    // on every boot.
    const probe = ws("probe");
    const gone = ws("gone");
    writeConfig({ probe });
    writeFileSync(join(gone, "openclaw-workspace-state.json"), "{}");
    writeFileSync(`${gone}.attested`, "x");

    run("migrate_legacy_openclaw_state");

    expect(calls()).toEqual([]);
  });

  it.each([
    ["an agent's sessions.json", ["agents", "gone", "sessions", "sessions.json"]],
    ["the state-level sessions.json", ["sessions", "sessions.json"]],
  ])("runs doctor for %s, even for an agent no longer configured", (_label, parts) => {
    // The session guard walks every agent dir on disk, not just configured
    // ones, and doctor imports them all — a deleted agent's chats included.
    writeConfig({ probe: ws("probe") });
    mkdirSync(join(stateDir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(stateDir, ...parts), "{}");

    run("migrate_legacy_openclaw_state");

    expect(calls()).toHaveLength(1);
  });

  it("points doctor at a throwaway copy and leaves openclaw.json byte-identical", () => {
    const probe = ws("probe");
    const original = writeConfig({ probe });
    writeFileSync(join(probe, "openclaw-workspace-state.json"), "{}");
    // Doctor --fix rewrites the config it is given and drops a backup beside it.
    stubOpenclaw(
      0,
      `echo '{"rewritten":true}' > "$OPENCLAW_CONFIG_PATH"; echo old > "$OPENCLAW_CONFIG_PATH.bak"; mv '${probe}/openclaw-workspace-state.json' '${probe}/openclaw-workspace-state.json.migrated.x'`
    );

    const { status, output } = run("migrate_legacy_openclaw_state");

    expect(status).toBe(0);
    const [call] = calls();
    expect(call.configPath).not.toBeNull();
    expect(call.configPath).not.toBe(join(stateDir, "openclaw.json"));
    expect(call.stateDir).toBe(stateDir);
    expect(readFileSync(join(stateDir, "openclaw.json"), "utf8")).toBe(original);
    // The copy and whatever doctor left beside it are gone.
    expect(existsSync(call.configPath!)).toBe(false);
    expect(existsSync(`${call.configPath}.bak`)).toBe(false);
    expect(readdirSync(stateDir).filter((f) => f.includes("migration"))).toEqual([]);
    expect(output).toMatch(/\[state-migration\].*complete/i);
  });

  it("judges success by what is left on disk, not by doctor's exit code", () => {
    // doctor --fix runs dozens of unrelated checks; one of them failing after
    // the import must not tell the operator the gateway won't start.
    const probe = ws("probe");
    writeConfig({ probe });
    writeFileSync(join(probe, "openclaw-workspace-state.json"), "{}");
    stubOpenclaw(
      2,
      `mv '${probe}/openclaw-workspace-state.json' '${probe}/openclaw-workspace-state.json.migrated.x'`
    );

    const { output } = run("migrate_legacy_openclaw_state");

    expect(output).not.toContain("FAILED");
    expect(output).toMatch(/\[state-migration\].*complete.*exit 2/i);
  });

  it("fails open when the config copy cannot be made", () => {
    const probe = ws("probe");
    writeConfig({ probe });
    writeFileSync(join(probe, "openclaw-workspace-state.json"), "{}");

    const { status, output } = run(
      `TMPDIR='${join(root, "missing-dir")}' migrate_legacy_openclaw_state`
    );

    expect(status).toBe(0);
    expect(output).toMatch(/\[state-migration\].*FAILED/);
    expect(calls()).toEqual([]);
  });

  it("fails open but loudly, with the manual command, when doctor fails", () => {
    const probe = ws("probe");
    writeConfig({ probe });
    writeFileSync(join(probe, "openclaw-workspace-state.json"), "{}");
    stubOpenclaw(3);

    const { status, output } = run("migrate_legacy_openclaw_state");

    expect(status).toBe(0);
    expect(output).toMatch(/\[state-migration\].*FAILED.*exit 3/);
    expect(output).toContain("openclaw doctor --fix");
  });

  it("warns when doctor exits 0 but legacy state is still on disk", () => {
    const probe = ws("probe");
    writeConfig({ probe });
    writeFileSync(join(probe, "openclaw-workspace-state.json"), "{}");

    const { status, output } = run("migrate_legacy_openclaw_state");

    expect(status).toBe(0);
    expect(output).toMatch(/\[state-migration\].*FAILED.*exit 0/);
    expect(output).toContain("openclaw-workspace-state.json");
  });

  it("does nothing without an openclaw.json", () => {
    // First boot of a fresh install: Pinchy has not written the config yet.
    const { status } = run("migrate_legacy_openclaw_state");

    expect(status).toBe(0);
    expect(calls()).toEqual([]);
  });
});

describe("migrate_legacy_openclaw_state — wiring", () => {
  // An extracted script that never reaches the container migrates nothing, and
  // the tests above would stay green the whole time.
  const startScript = () => readFileSync(resolve(REPO_ROOT, "config/start-openclaw.sh"), "utf8");

  it("is sourced by start-openclaw.sh", () => {
    expect(startScript()).toContain("source /migrate-openclaw-state.sh");
  });

  it("runs before every gateway start, after secrets and credentials are root-owned", () => {
    // The watchdog's restart branch starts a gateway too, and doctor resolves
    // SecretRefs, which OpenClaw refuses unless secrets.json is root-owned.
    const lines = startScript().split("\n");
    const starts = lines.flatMap((line, i) => (/^\s*openclaw gateway\b/.test(line) ? [i] : []));
    expect(starts.length).toBeGreaterThan(1);
    for (const start of starts) {
      const window = lines.slice(Math.max(0, start - 15), start);
      const migrate = window.findIndex((l) => /^\s*migrate_legacy_openclaw_state\s*$/.test(l));
      expect(migrate).toBeGreaterThanOrEqual(0);
      expect(window.findIndex((l) => /^\s*ensure_secrets_root_owned\s*$/.test(l))).toBeLessThan(
        migrate
      );
      expect(window.findIndex((l) => /^\s*restore_credentials_privacy\s*$/.test(l))).toBeLessThan(
        migrate
      );
    }
  });

  it("is copied into the OpenClaw image", () => {
    const dockerfile = readFileSync(resolve(REPO_ROOT, "Dockerfile.openclaw"), "utf8");
    expect(dockerfile).toContain(
      "COPY config/migrate-openclaw-state.sh /migrate-openclaw-state.sh"
    );
  });
});
