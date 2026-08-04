import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";

// config/fix-config-permissions.sh is start-openclaw.sh's 50 ms permission tick,
// extracted into a sourceable helper (same pattern as install-plugin-deps.sh and
// stage-llama-cpp-provider.sh) so its invariants are unit-testable. The tick is
// the only place in the stack that can repair cross-uid state on the shared
// `openclaw-config` volume: OpenClaw runs as root, Pinchy as uid 999, and only
// root can chown.
//
// THE INVARIANT THIS FILE EXISTS FOR (#934):
//
//   /openclaw-config/agents/<id>/agent must be OWNED by the pinchy uid.
//
// Not "must have mode X" — ownership, specifically. OpenClaw's per-agent
// models.json writer creates that directory with `mkdir(…, { mode: 0o700 })` and
// then re-asserts 0700 on EVERY write (`enforcePrivatePathMode` chmods and
// verifies). Root is exempt from mode bits, so a mode-only repair is both
// pointless (OpenClaw immediately undoes it) and insufficient (0755 root-owned
// still denies uid 999 the write). Ownership is the only durable lever: once the
// directory is pinchy-owned, OpenClaw's 0700 reads as "pinchy rwx" and root
// keeps writing regardless.
//
// When OpenClaw wins the race to create that directory, Pinchy's
// writeAgentAuthProfiles() gets EACCES forever — which aborts
// regenerateOpenClawConfig() before it pushes openclaw.json, so OpenClaw never
// learns the provider and every dispatch fails `Unknown model: openai/…`. The
// user-visible symptom is "Smithers doesn't answer" (setup-wizard E2E, CI run
// 30554860337).
//
// `chown` is stubbed on PATH: a non-root test process cannot chown to uid 999,
// and the syscall itself is the kernel's business. Everything else runs for
// real — the real bash function, real `find` traversal, real gates, real chmod —
// so the assertions below are about what the script actually decides to do, not
// about a re-implementation of it.

const REPO_ROOT = resolve(__dirname, "../../../../..");
const SCRIPT = resolve(REPO_ROOT, "config/fix-config-permissions.sh");

// A uid the temp fixtures are guaranteed NOT to be owned by, so the "skip what
// is already correct" gate doesn't swallow the assertions.
const PINCHY_UID = "999";
const PINCHY_GID = "999";

let root: string;
let stateDir: string;
let secretsFile: string;
let binDir: string;
let chownLog: string;

/** Record every `chown` invocation instead of performing it. */
function stubChown(): void {
  const bin = join(binDir, "chown");
  writeFileSync(bin, `#!/bin/bash\necho "$@" >> '${chownLog}'\nexit 0\n`);
  chmodSync(bin, 0o755);
}

function runFix(): void {
  execFileSync("bash", ["-c", `source '${SCRIPT}'; fix_config_permissions`], {
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      OPENCLAW_STATE_DIR: stateDir,
      SECRETS_FILE: secretsFile,
      PINCHY_UID,
      PINCHY_GID,
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

/** Paths passed to `chown <owner> <path>`, in invocation order. */
function chownedPaths(): string[] {
  if (!existsSync(chownLog)) return [];
  return readFileSync(chownLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ").slice(1).join(" "));
}

/** Create an agent directory tree the way OpenClaw does: mode 0700 throughout. */
function seedAgentDir(agentId: string): { agentIdDir: string; agentDir: string } {
  const agentIdDir = join(stateDir, "agents", agentId);
  const agentDir = join(agentIdDir, "agent");
  mkdirSync(agentDir, { recursive: true });
  chmodSync(agentIdDir, 0o700);
  chmodSync(agentDir, 0o700);
  return { agentIdDir, agentDir };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fix-config-perms-"));
  stateDir = join(root, "openclaw");
  binDir = join(root, "bin");
  chownLog = join(root, "chown.log");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(stateDir, "agents"), { recursive: true });
  secretsFile = join(root, "secrets", "secrets.json");
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(stateDir, "openclaw.json"), "{}\n");
  stubChown();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("fix_config_permissions — per-agent directory ownership (#934)", () => {
  it("chowns agents/<id>/agent to the pinchy uid so Pinchy can write auth-profiles.json", () => {
    const { agentDir } = seedAgentDir("f18382bd-c4b3-4826-a3da-89046629f310");

    runFix();

    // The regression: repairing only the mode leaves the directory root-owned,
    // and root-owned 0700 (which OpenClaw re-asserts on every models.json write)
    // is exactly what denies uid 999 the write.
    expect(chownedPaths()).toContain(agentDir);
  });

  it("chowns agents/<id> so Pinchy can create the agent/ subdirectory itself", () => {
    const { agentIdDir } = seedAgentDir("agent-a");

    runFix();

    expect(chownedPaths()).toContain(agentIdDir);
  });

  it("covers every agent, not just the first one found", () => {
    const a = seedAgentDir("agent-a");
    const b = seedAgentDir("agent-b");

    runFix();

    const chowned = chownedPaths();
    expect(chowned).toContain(a.agentDir);
    expect(chowned).toContain(b.agentDir);
  });

  it("keeps chowning the agents/ root itself (new agent dirs must be creatable)", () => {
    runFix();

    expect(chownedPaths()).toContain(join(stateDir, "agents"));
  });

  it("skips directories already owned by the pinchy uid", () => {
    // chown rewrites ctime, and start-openclaw.sh's own comments record that
    // OpenClaw's session-takeover detector treats a ctime change as external
    // modification. At a 50 ms tick an ungated chown is ~20 ctime bumps/second
    // per agent directory, forever.
    seedAgentDir("agent-a");

    execFileSync("bash", ["-c", `source '${SCRIPT}'; fix_config_permissions`], {
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_STATE_DIR: stateDir,
        SECRETS_FILE: secretsFile,
        // Everything under the temp root is already owned by the test process.
        PINCHY_UID: String(process.getuid?.() ?? 0),
        PINCHY_GID: String(process.getgid?.() ?? 0),
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

    expect(chownedPaths()).toEqual([]);
  });

  it("tolerates a missing agents/ directory (pre-first-agent boot)", () => {
    rmSync(join(stateDir, "agents"), { recursive: true, force: true });

    expect(() => runFix()).not.toThrow();
  });
});

// THE SECOND INVARIANT (#1095):
//
//   workspaces/<id>/<bootstrap file> must be OWNED by the pinchy uid.
//
// Same cross-uid trap as agents/<id>/agent above, one directory over, and it
// reached production: on 2026-08-04 `pinchy.heypinchy.com` had two root-owned
// TOOLS.md files, and every agent save had failed since 2026-08-02 08:25 — the
// last successful `agent.updated` audit row. The user saw "Failed to save some
// settings" and nothing else.
//
// The mechanism is a race that Pinchy itself opens. writeToolsFile() DELETES
// TOOLS.md when an agent has no mailbox (rmSync — "no stale mailbox identity
// survives a permission revocation"). OpenClaw creates the file from its own
// bootstrap template whenever it is missing, as root, mode 0644. Grant the
// agent an email connection afterwards and Pinchy's writeFileSync gets EACCES
// forever — root-owned 0644 denies uid 999 the write, and root ignores mode
// bits, so no chmod can substitute for ownership here either.
//
// The blast radius is the same as #934's and worth spelling out, because the
// two user-visible symptoms look unrelated: the EACCES aborts
// regenerateOpenClawConfig() BEFORE it pushes openclaw.json, so
//   (a) the model the user just saved never reaches the runtime, and
//   (b) pinchy-email never enters the plugin list, so the agent has no email_*
//       tools at all and correctly answers "I have no access to a mailbox" —
//       while the Permissions tab shows the mailbox connected and saved.
describe("fix_config_permissions — workspace bootstrap file ownership (#1095)", () => {
  /** Create a workspace the way OpenClaw does: root-owned bootstrap files. */
  function seedWorkspaceFile(agentId: string, name: string): string {
    const dir = join(stateDir, "workspaces", agentId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "# placeholder\n");
    return file;
  }

  it("chowns workspaces/<id>/TOOLS.md so Pinchy can write the mailbox context", () => {
    const file = seedWorkspaceFile("025449c8-12b8-4919-a427-86a1ee7a4a77", "TOOLS.md");

    runFix();

    expect(chownedPaths()).toContain(file);
  });

  it.each(["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md"])(
    "chowns workspaces/<id>/%s — OpenClaw bootstraps all of these, Pinchy writes them too",
    (name) => {
      const file = seedWorkspaceFile("agent-a", name);

      runFix();

      expect(chownedPaths()).toContain(file);
    }
  );

  it("covers every workspace, not just the first one found", () => {
    const a = seedWorkspaceFile("agent-a", "TOOLS.md");
    const b = seedWorkspaceFile("agent-b", "TOOLS.md");

    runFix();

    const chowned = chownedPaths();
    expect(chowned).toContain(a);
    expect(chowned).toContain(b);
  });

  it("chowns the workspace directory itself, so a deleted file can be recreated", () => {
    // writeToolsFile() removes TOOLS.md for an agent with no mailbox and
    // recreates it when one is granted. Recreating needs write permission on
    // the DIRECTORY, which a file-only repair would never grant.
    seedWorkspaceFile("agent-a", "TOOLS.md");

    runFix();

    expect(chownedPaths()).toContain(join(stateDir, "workspaces", "agent-a"));
  });

  it("skips workspace files already owned by the pinchy uid", () => {
    // Same ctime argument as the agents/ gate above: at a 50 ms tick an
    // ungated chown is ~20 ctime bumps a second, per file, forever.
    seedWorkspaceFile("agent-a", "TOOLS.md");

    execFileSync("bash", ["-c", `source '${SCRIPT}'; fix_config_permissions`], {
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_STATE_DIR: stateDir,
        SECRETS_FILE: secretsFile,
        PINCHY_UID: String(process.getuid?.() ?? 0),
        PINCHY_GID: String(process.getgid?.() ?? 0),
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

    expect(chownedPaths()).toEqual([]);
  });

  it("leaves agent-created content below the bootstrap level alone", () => {
    // The tick runs every 50 ms. Workspaces hold uploads/ and memory/ with
    // unbounded file counts, so the repair is scoped to the bootstrap files
    // Pinchy actually writes — a recursive sweep would re-stat the whole
    // corpus 20 times a second for no benefit.
    const dir = join(stateDir, "workspaces", "agent-a", "uploads");
    mkdirSync(dir, { recursive: true });
    const upload = join(dir, "invoice.pdf");
    writeFileSync(upload, "%PDF\n");

    runFix();

    expect(chownedPaths()).not.toContain(upload);
  });

  it("tolerates a missing workspaces/ directory (pre-first-agent boot)", () => {
    expect(() => runFix()).not.toThrow();
  });
});

describe("fix_config_permissions — behaviour carried over from start-openclaw.sh", () => {
  it("makes openclaw.json writable by Pinchy (mode 666)", () => {
    chmodSync(join(stateDir, "openclaw.json"), 0o600);

    runFix();

    expect(statSync(join(stateDir, "openclaw.json")).mode & 0o777).toBe(0o666);
  });

  it("tightens auth-profiles.json to 0600", () => {
    const { agentDir } = seedAgentDir("agent-a");
    const file = join(agentDir, "auth-profiles.json");
    writeFileSync(file, "{}\n");
    chmodSync(file, 0o644);

    runFix();

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("opens agents/<id> to 0755 so Pinchy can traverse it", () => {
    const { agentIdDir } = seedAgentDir("agent-a");

    runFix();

    expect(statSync(agentIdDir).mode & 0o777).toBe(0o755);
  });

  it("opens sessions/ and its session files for Pinchy's diagnostics export", () => {
    const sessionsDir = join(stateDir, "agents", "agent-a", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    chmodSync(sessionsDir, 0o700);
    const sessions = join(sessionsDir, "sessions.json");
    const trajectory = join(sessionsDir, "run-1.trajectory.jsonl");
    writeFileSync(sessions, "{}\n");
    writeFileSync(trajectory, "\n");
    chmodSync(sessions, 0o600);
    chmodSync(trajectory, 0o600);

    runFix();

    expect(statSync(sessionsDir).mode & 0o777).toBe(0o755);
    expect(statSync(sessions).mode & 0o777).toBe(0o644);
    expect(statSync(trajectory).mode & 0o777).toBe(0o644);
  });

  it("re-takes ownership of the secrets file when it exists", () => {
    writeFileSync(secretsFile, "{}\n");

    runFix();

    expect(chownedPaths()).toContain(secretsFile);
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  it("skips the secrets file when it does not exist", () => {
    runFix();

    expect(chownedPaths()).not.toContain(secretsFile);
  });
});

describe("fix_config_permissions — wiring", () => {
  // An extracted script that never reaches the container repairs nothing, and
  // the tests above would stay green the whole time.
  it("is sourced by start-openclaw.sh", () => {
    const startScript = readFileSync(resolve(REPO_ROOT, "config/start-openclaw.sh"), "utf8");
    expect(startScript).toContain("source /fix-config-permissions.sh");
    expect(startScript).toContain("fix_config_permissions");
  });

  it("is copied into the OpenClaw image", () => {
    const dockerfile = readFileSync(resolve(REPO_ROOT, "Dockerfile.openclaw"), "utf8");
    expect(dockerfile).toContain(
      "COPY config/fix-config-permissions.sh /fix-config-permissions.sh"
    );
  });
});
