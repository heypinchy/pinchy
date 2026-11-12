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

/**
 * Record every `chmod` invocation while still performing it, and return a
 * reader for the recorded argument lines.
 *
 * The 50 ms tick's gates are asserted on the chmod call, not on ctime: Linux
 * rewrites ctime on a chmod to the mode a file already has (and raises an
 * inotify attribute event), macOS does not, so a ctime assertion would pass on
 * a developer's Mac whatever the script did.
 */
function recordChmod(): () => string {
  const chmodLog = join(root, "chmod.log");
  const realChmod = execFileSync("bash", ["-c", "command -v chmod"], {
    encoding: "utf8",
  }).trim();
  const wrapper = join(binDir, "chmod");
  writeFileSync(wrapper, `#!/bin/bash\necho "$@" >> '${chmodLog}'\nexec '${realChmod}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  return () => (existsSync(chmodLog) ? readFileSync(chmodLog, "utf8") : "");
}

function runFix(extraEnv: Record<string, string> = {}): void {
  execFileSync("bash", ["-c", `source '${SCRIPT}'; fix_config_permissions`], {
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      OPENCLAW_STATE_DIR: stateDir,
      SECRETS_FILE: secretsFile,
      PINCHY_UID,
      PINCHY_GID,
      ...extraEnv,
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
  it("chowns agents/<id>/agent to the pinchy uid", () => {
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
// The mechanism was a race that Pinchy itself opened. Up to OpenClaw 2026.7
// Pinchy kept the mailbox context in TOOLS.md and DELETED it when an agent had
// no mailbox (rmSync — "no stale mailbox identity
// survives a permission revocation"). OpenClaw creates the file from its own
// bootstrap template whenever it is missing, as root, mode 0644. Grant the
// agent an email connection afterwards and Pinchy's writeFileSync gets EACCES
// forever — root-owned 0644 denies uid 999 the write, and root ignores mode
// bits, so no chmod can substitute for ownership here either. The context
// lives in IDENTITY.md since OpenClaw 2026.9 (writeMailboxContext), which
// OpenClaw seeds root-owned the same way.
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

  it("chowns workspaces/<id>/IDENTITY.md so Pinchy can write the mailbox context", () => {
    const file = seedWorkspaceFile("025449c8-12b8-4919-a427-86a1ee7a4a77", "IDENTITY.md");

    runFix();

    expect(chownedPaths()).toContain(file);
  });

  it.each(["AGENTS.md", "SOUL.md", "TOOLS.md", "USER.md", "HEARTBEAT.md"])(
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
    // Pinchy removes and recreates bootstrap files (the old TOOLS.md, a
    // reclaimed IDENTITY.md). Both need write permission on the DIRECTORY,
    // which a file-only repair would never grant.
    seedWorkspaceFile("agent-a", "TOOLS.md");

    runFix();

    expect(chownedPaths()).toContain(join(stateDir, "workspaces", "agent-a"));
  });

  it("chowns the workspaces/ root itself, so a NEW agent's workspace can be created", () => {
    // `-maxdepth 1 -type d` matches depth 0 as well as depth 1, and that is
    // deliberate rather than incidental. ensureWorkspace() mkdirs
    // workspaces/<id> as uid 999, which needs write permission on the parent —
    // so a root-owned workspaces/ breaks every agent that does not exist yet,
    // a failure the per-agent repair below would never reach.
    seedWorkspaceFile("agent-a", "TOOLS.md");

    runFix();

    expect(chownedPaths()).toContain(join(stateDir, "workspaces"));
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

  it("leaves an openclaw.json that is already 0666 untouched", () => {
    // OpenClaw 2026.9 watches openclaw.json with a 300 ms debounce that every
    // event restarts — attribute events included. An ungated chmod on the 50 ms
    // tick fires one every 50 ms, so the debounce never elapses: a config Pinchy
    // writes to the file is never reloaded, and every later config.apply fails
    // "config changed since last load" against the stale snapshot.
    const file = join(stateDir, "openclaw.json");
    chmodSync(file, 0o666);
    const chmodCalls = recordChmod();

    runFix();

    expect(chmodCalls()).not.toContain(file);
  });

  it("opens credentials/ and the files in it for Pinchy to read", () => {
    const credentials = join(stateDir, "credentials");
    mkdirSync(credentials);
    const allowFrom = join(credentials, "telegram-allowFrom.json");
    writeFileSync(allowFrom, "{}\n");
    chmodSync(allowFrom, 0o600);
    chmodSync(credentials, 0o700);

    runFix();

    expect(statSync(credentials).mode & 0o777).toBe(0o755);
    expect(statSync(allowFrom).mode & 0o777).toBe(0o644);
  });

  it("leaves a credentials/ that Pinchy can already read untouched", () => {
    // Same 50 ms-tick reason as openclaw.json: each chmod is an inotify
    // attribute event, even to the mode a file already has. OpenClaw 2026.9
    // does not watch credentials/, so this keeps the tick quiet before one does.
    const credentials = join(stateDir, "credentials");
    mkdirSync(credentials);
    writeFileSync(join(credentials, "telegram-allowFrom.json"), "{}\n");
    chmodSync(join(credentials, "telegram-allowFrom.json"), 0o644);
    chmodSync(credentials, 0o755);
    const chmodCalls = recordChmod();

    runFix();

    expect(chmodCalls()).not.toContain(credentials);
  });

  // Up to OpenClaw 2026.8 this tick opened agents/<id> and agents/<id>/sessions
  // to 0755 and sessions.json / *.trajectory.jsonl to 0644 for Pinchy's
  // diagnostics export. OpenClaw 2026.9 keeps sessions and trajectories in a
  // per-agent SQLite database at mode 0600 that the gateway owns,
  // and the pinchy-audit plugin reads it inside the gateway
  // (`pinchy.trajectory.read`). Nothing running as uid 999 opens a path under
  // agents/<id>/ any more, so a widened mode there is exposure with no reader —
  // and a chmod on a tree OpenClaw writes to on every turn.
  it("does not widen anything under agents/<id>, and does not touch the tree with chmod", () => {
    const { agentIdDir, agentDir } = seedAgentDir("agent-a");
    const sessionsDir = join(agentIdDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    chmodSync(sessionsDir, 0o700);
    const sessions = join(sessionsDir, "sessions.json");
    const trajectory = join(sessionsDir, "run-1.trajectory.jsonl");
    const agentDb = join(agentDir, "openclaw-agent.sqlite");
    for (const file of [sessions, trajectory, agentDb]) {
      writeFileSync(file, "\n");
      chmodSync(file, 0o600);
    }
    const chmodCalls = recordChmod();

    runFix();

    expect(statSync(agentIdDir).mode & 0o777).toBe(0o700);
    expect(statSync(sessionsDir).mode & 0o777).toBe(0o700);
    expect(statSync(sessions).mode & 0o777).toBe(0o600);
    expect(statSync(trajectory).mode & 0o777).toBe(0o600);
    expect(statSync(agentDb).mode & 0o777).toBe(0o600);
    expect(chmodCalls()).not.toContain(join(stateDir, "agents"));
  });

  it("still chowns agents/<id> for a tree that holds sessions/, without changing its mode", () => {
    // The ownership repair (#934) is separate from the mode repair removed
    // above. This is also the liveness guard for the test above: it proves the
    // function ran to the end, so "no chmod" cannot pass by an early abort.
    const { agentIdDir } = seedAgentDir("agent-a");
    mkdirSync(join(agentIdDir, "sessions"), { recursive: true });

    runFix();

    expect(chownedPaths()).toContain(agentIdDir);
    expect(statSync(agentIdDir).mode & 0o777).toBe(0o700);
  });

  it("re-takes ownership of the secrets file when it exists", () => {
    writeFileSync(secretsFile, "{}\n");

    runFix();

    expect(chownedPaths()).toContain(secretsFile);
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  it("tightens a secrets file Pinchy left readable back to 0600", () => {
    writeFileSync(secretsFile, "{}\n");
    chmodSync(secretsFile, 0o644);

    runFix();

    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  it("leaves a secrets file that is already OpenClaw's and 0600 untouched", () => {
    // Ungated, the 50 ms tick raised two attribute events on the file every
    // 50 ms. OPENCLAW_UID stands in for root here: the test process cannot own
    // a file as root.
    writeFileSync(secretsFile, "{}\n");
    chmodSync(secretsFile, 0o600);
    const chmodCalls = recordChmod();

    runFix({ OPENCLAW_UID: String(process.getuid!()) });

    expect(chownedPaths()).not.toContain(secretsFile);
    expect(chmodCalls()).not.toContain(secretsFile);
  });

  it("skips the secrets file when it does not exist", () => {
    runFix();

    expect(chownedPaths()).not.toContain(secretsFile);
  });
});

// OpenClaw 2026.9 retired the per-agent auth-profiles.json: profiles live in
// its SQLite store now. A file an earlier Pinchy wrote, next to an empty store,
// is read as unmigrated credentials — OpenClaw marks that agent
// AuthProfileMigrationRequiredError ("run openclaw doctor --fix") and refuses
// every dispatch for it. Nothing in a Pinchy deployment runs doctor, and there
// is nothing to migrate: the file only ever held a keyRef to the provider key
// that openclaw.json already hands OpenClaw as a SecretRef.
describe("remove_retired_auth_profiles", () => {
  function runRemove(): void {
    execFileSync("bash", ["-c", `source '${SCRIPT}'; remove_retired_auth_profiles`], {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  }

  it("removes every agent's auth-profiles.json and leaves the rest of agent/ alone", () => {
    const a = seedAgentDir("agent-a");
    const b = seedAgentDir("agent-b");
    for (const { agentDir } of [a, b]) {
      writeFileSync(join(agentDir, "auth-profiles.json"), "{}\n");
      writeFileSync(join(agentDir, "models.json"), "{}\n");
    }

    runRemove();

    for (const { agentDir } of [a, b]) {
      expect(existsSync(join(agentDir, "auth-profiles.json"))).toBe(false);
      expect(existsSync(join(agentDir, "models.json"))).toBe(true);
    }
  });

  it("tolerates a missing agents/ directory (pre-first-agent boot)", () => {
    rmSync(join(stateDir, "agents"), { recursive: true, force: true });

    expect(() => runRemove()).not.toThrow();
  });
});

// OpenClaw 2026.9 keeps its gateway lock directory in the state dir
// (`tmp/openclaw-<uid>`, mode 0700) and refuses to start when that directory is
// not owned by its own uid ("device identity coordinator directory belongs to
// another user"). fix-volume-ownership.sh no longer hands tmp/ to the pinchy
// uid; this is the migration half for a volume an earlier Pinchy already did.
describe("restore_gateway_lock_ownership", () => {
  function runRestore(): void {
    execFileSync("bash", ["-c", `source '${SCRIPT}'; restore_gateway_lock_ownership`], {
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  }

  it("hands a lock directory owned by another uid back to root", () => {
    const lockDir = join(stateDir, "tmp", "openclaw-0");
    mkdirSync(lockDir, { recursive: true });
    const lockFile = join(lockDir, "device-identity.0123abcd.lock.sqlite");
    writeFileSync(lockFile, "");

    runRestore();

    // The test process is not root, so every fixture counts as foreign-owned.
    expect(chownedPaths()).toEqual(
      expect.arrayContaining([join(stateDir, "tmp"), lockDir, lockFile])
    );
    expect(readFileSync(chownLog, "utf8")).toContain("root:root");
  });

  it("touches nothing outside tmp/", () => {
    seedAgentDir("agent-a");
    mkdirSync(join(stateDir, "tmp", "openclaw-0"), { recursive: true });

    runRestore();

    expect(chownedPaths().every((p) => p.startsWith(join(stateDir, "tmp")))).toBe(true);
  });

  it("tolerates a missing tmp/ (first boot)", () => {
    expect(() => runRestore()).not.toThrow();
    expect(chownedPaths()).toEqual([]);
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

  it("removes the retired auth-profiles.json before every gateway start", () => {
    // Before the start, not on the 50 ms tick: OpenClaw reads the file when the
    // gateway boots, and Pinchy no longer writes one, so once per start covers
    // the upgraded install.
    const startScript = readFileSync(resolve(REPO_ROOT, "config/start-openclaw.sh"), "utf8");
    const lines = startScript.split("\n");
    const starts = lines.flatMap((line, i) => (/^\s*openclaw gateway\b/.test(line) ? [i] : []));
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      const before = lines.slice(Math.max(0, start - 15), start).join("\n");
      expect(before).toContain("remove_retired_auth_profiles");
    }
  });

  it("restores the gateway lock directory's ownership before every gateway start", () => {
    // The gateway checks the directory at startup, and the restart branch of
    // the watchdog loop starts a gateway too.
    const startScript = readFileSync(resolve(REPO_ROOT, "config/start-openclaw.sh"), "utf8");
    const lines = startScript.split("\n");
    const starts = lines.flatMap((line, i) => (/^\s*openclaw gateway\b/.test(line) ? [i] : []));
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      const before = lines.slice(Math.max(0, start - 15), start).join("\n");
      expect(before).toContain("restore_gateway_lock_ownership");
    }
  });

  it("is copied into the OpenClaw image", () => {
    const dockerfile = readFileSync(resolve(REPO_ROOT, "Dockerfile.openclaw"), "utf8");
    expect(dockerfile).toContain(
      "COPY config/fix-config-permissions.sh /fix-config-permissions.sh"
    );
  });
});
