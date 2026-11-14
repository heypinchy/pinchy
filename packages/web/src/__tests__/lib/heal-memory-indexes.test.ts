import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";

// config/heal-memory-indexes.sh rebuilds the agent memory indexes OpenClaw
// will not rebuild on its own, before the gateway starts.
//
// When an embed fails while an index is built, memory-core falls back to
// keyword-only and stamps the index "fts-only". Once embeddings work again the
// index is "mismatched", and memory-core rebuilds that only on an explicit
// `openclaw memory index` — so memory_search stays empty and tells the user to
// run a CLI command. The v0.11.0 RC left every index it touched like that.
//
// Contract pinned here:
//   1. Only "mismatched" indexes are rebuilt. "valid" ones are left alone, and
//      so are "missing" ones: the gateway's own sync builds those, and building
//      them here would hold an upgraded install's gateway back for the whole
//      first index.
//   2. One `openclaw memory index --agent <id>` per mismatched agent.
//   3. The outcome is judged by re-reading the status, not by exit codes:
//      `openclaw memory index` exits 0 even when it could not embed.
//   4. Fail open under `set -e`: an unreadable status, a failing rebuild or an
//      exhausted time budget never stops the gateway start.
//
// The `openclaw` binary is stubbed on PATH. The real rebuild against the real
// image is exercised by hand (see the PR) — the RC's fts-only state, healed by
// exactly this command.

const REPO_ROOT = resolve(__dirname, "../../../../..");
const SCRIPT = resolve(REPO_ROOT, "config/heal-memory-indexes.sh");

let root: string;
let stateDir: string;
let binDir: string;
let callLog: string;
let pkillLog: string;
let identities: string;
let templates: string;

// "mismatched" is memory-core's configuration-owned mismatch (the index was
// built for another embedding model — only `openclaw memory index` rebuilds
// it). "stale-format" is an openclaw-owned one (provenance or chunking
// version), which the gateway's own sync rebuilds.
type Identity = "valid" | "missing" | "mismatched" | "stale-format";

// The shape `openclaw memory status --json` prints (OpenClaw 2026.9.2), cut
// down to what the helper reads plus enough siblings to look real.
function statusEntry(agentId: string, identity: Identity) {
  const indexIdentity = {
    valid: { status: "valid" },
    missing: {
      status: "missing",
      reason: "index metadata is missing",
      code: "metadata_missing",
      owner: "openclaw",
    },
    mismatched: {
      status: "mismatched",
      reason:
        "index was built for model fts-only, expected /opt/embedding-models/embeddinggemma-300m-qat-Q8_0.gguf",
      code: "model",
      owner: "configuration",
    },
    "stale-format": {
      status: "mismatched",
      reason: "index was built with an older chunking version",
      code: "chunking_version",
      owner: "openclaw",
    },
  }[identity];
  return {
    agentId,
    status: {
      backend: "builtin",
      files: 1,
      chunks: identity === "missing" ? 0 : 3,
      dirty: identity !== "valid",
      provider: "local",
      custom: { searchMode: "hybrid", indexIdentity },
    },
    scan: { totalFiles: 1, issues: [] },
  };
}

type StubOptions = {
  /** `memory index` marks the agent valid, as a working rebuild does. */
  indexHeals?: boolean | string[];
  /** Exit code of `memory index`. */
  indexExit?: number;
  /** `memory index` becomes a sleep of this many seconds (exec'd, so a kill lands on it). */
  indexSleeps?: number;
  /** `memory index` reads its stdin to the end, as a CLI that prompts might. */
  indexReadsStdin?: boolean;
  /** `memory status` exits with this code before printing anything. */
  statusExit?: number;
  /** `memory status` prints its document, then exits with this code. */
  statusExitAfterPrint?: number;
  statusPrefix?: string;
  /** Replaces the generated status document entirely. */
  rawStatus?: string;
};

// A stub `openclaw` that logs argv, answers `memory status [--agent <id>]
// --json` from the identities file, and — unless told otherwise — marks an
// agent valid when `memory index --agent <id>` runs for it, as the real
// rebuild does.
function stubOpenclaw(opts: StubOptions = {}) {
  const {
    indexHeals = true,
    indexExit = 0,
    indexSleeps,
    indexReadsStdin = false,
    statusExit = 0,
    statusExitAfterPrint = 0,
    statusPrefix = "",
    rawStatus,
  } = opts;
  const healing = indexHeals === true ? "*" : indexHeals === false ? "" : indexHeals.join(" ");
  const bin = join(binDir, "openclaw");
  writeFileSync(
    bin,
    `#!/bin/bash
node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))+"\\n")' '${callLog}' "$@"
if [ "$1 $2" = "memory status" ]; then
  agent=""
  [ "$3" = "--agent" ] && agent="$4"
  [ ${statusExit} -eq 0 ] || exit ${statusExit}
  echo "[plugins] pinchy-files failed during register" >&2
  printf '%b' '${statusPrefix}'
  ${rawStatus === undefined ? "" : `printf '%b' '${rawStatus}'; exit 0`}
  node -e '
const fs = require("fs");
const ids = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const templates = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const only = process.argv[3];
const entries = Object.entries(ids).filter(([id]) => !only || id === only);
console.log(JSON.stringify(entries.map(([id, s]) => ({ ...templates[s], agentId: id })), null, 2));
' '${identities}' '${templates}' "$agent"
  exit ${statusExitAfterPrint}
fi
if [ "$1 $2 $3" = "memory index --agent" ]; then
  ${indexReadsStdin ? "cat >/dev/null" : ""}
  ${indexSleeps === undefined ? "" : `exec sleep ${indexSleeps}`}
  echo "Memory index updated ($4)."
  if [ "${healing}" = "*" ] || [[ " ${healing} " == *" $4 "* ]]; then
    node -e '
const fs = require("fs");
const ids = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
ids[process.argv[2]] = "valid";
fs.writeFileSync(process.argv[1], JSON.stringify(ids));
' '${identities}' "$4"
  fi
  exit ${indexExit}
fi
exit 0
`
  );
  chmodSync(bin, 0o755);
}

// pkill is always stubbed: the real one would reach the developer's own
// processes. `aliveFor` is how many calls find a llama-server to signal
// (exit 0) before none is left (exit 1, as pkill reports "no match"); the
// default is none at all.
function stubPkill(aliveFor = 0) {
  const bin = join(binDir, "pkill");
  writeFileSync(
    bin,
    `#!/bin/bash
node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))+"\\n")' '${pkillLog}' "$@"
[ "$(wc -l < '${pkillLog}')" -le ${aliveFor} ]
`
  );
  chmodSync(bin, 0o755);
}

function pkillCalls(): string[][] {
  if (!existsSync(pkillLog)) return [];
  return readFileSync(pkillLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
}

function setIdentities(ids: Record<string, Identity>): void {
  writeFileSync(identities, JSON.stringify(ids));
}

function calls(): string[][] {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
}

const indexCalls = () => calls().filter((argv) => argv[1] === "index");

// Runs under `set -e`, as start-openclaw.sh does; the trailing marker proves
// the caller kept going, so "fails open" is a fact and not a claim.
function run(env: Record<string, string> = {}): string {
  const script = `set -e; source '${SCRIPT}'; heal_memory_indexes 2>&1; echo CALLER-CONTINUED`;
  const result = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      OPENCLAW_STATE_DIR: stateDir,
      ...env,
    },
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("CALLER-CONTINUED");
  return result.stdout;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heal-memory-"));
  stateDir = join(root, "state");
  binDir = join(root, "bin");
  callLog = join(root, "calls.jsonl");
  pkillLog = join(root, "pkill.jsonl");
  identities = join(root, "identities.json");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  templates = join(root, "status-templates.json");
  writeFileSync(
    templates,
    JSON.stringify({
      valid: statusEntry("template", "valid"),
      missing: statusEntry("template", "missing"),
      mismatched: statusEntry("template", "mismatched"),
      "stale-format": statusEntry("template", "stale-format"),
    })
  );
  writeFileSync(join(stateDir, "openclaw.json"), "{}");
  stubOpenclaw();
  stubPkill();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("heal_memory_indexes", () => {
  it("does nothing more than one status query when every index is valid or missing", () => {
    setIdentities({ smithers: "valid", fresh: "missing" });

    const output = run();

    expect(calls()).toEqual([["memory", "status", "--json"]]);
    expect(output).not.toContain("[memory-heal]");
  });

  it("rebuilds exactly the mismatched indexes, one agent at a time", () => {
    setIdentities({ smithers: "valid", kb: "mismatched", fresh: "missing", odoo: "mismatched" });

    const output = run();

    expect(indexCalls()).toEqual([
      ["memory", "index", "--agent", "kb"],
      ["memory", "index", "--agent", "odoo"],
    ]);
    expect(output).toMatch(/Memory indexes rebuilt in \d+s/);
  });

  it("leaves mismatches OpenClaw owns to the gateway", () => {
    // owner "openclaw" (provenance or chunking version) is rebuilt by the
    // gateway's own sync; rebuilding it here would only hold the start back.
    setIdentities({ kb: "mismatched", old: "stale-format" });

    run();

    expect(indexCalls()).toEqual([["memory", "index", "--agent", "kb"]]);
  });

  it("gives the rebuild no stdin, so it cannot swallow the agents still to come", () => {
    setIdentities({ kb: "mismatched", odoo: "mismatched" });
    stubOpenclaw({ indexReadsStdin: true });

    run();

    expect(indexCalls()).toEqual([
      ["memory", "index", "--agent", "kb"],
      ["memory", "index", "--agent", "odoo"],
    ]);
  });

  it("judges the outcome by the status afterwards, not by the exit code", () => {
    // `openclaw memory index` exits 0 when every embed failed and the index was
    // left dirty — measured on the RC image. A success line then would be a lie.
    setIdentities({ kb: "mismatched" });
    stubOpenclaw({ indexHeals: false });

    const output = run();

    expect(indexCalls()).toEqual([["memory", "index", "--agent", "kb"]]);
    expect(output).toContain("FAILED");
    expect(output).toContain("[memory-heal]   kb");
    expect(output).not.toContain("rebuilt in");
  });

  it.each([
    ["is still mismatched afterwards", { indexHeals: false }],
    ["exits non-zero", { indexExit: 1 }],
  ])("stops after the first rebuild that %s", (_label, stub) => {
    // A rebuild fails because embeddings fail, and those fail for every agent
    // alike. Trying the rest would spend the whole budget on each start for
    // nothing while the gateway waits.
    setIdentities({ kb: "mismatched", odoo: "mismatched", hr: "mismatched" });
    stubOpenclaw(stub);

    const output = run();

    expect(indexCalls()).toEqual([["memory", "index", "--agent", "kb"]]);
    expect(output.match(/not trying the remaining agents/gi)).toHaveLength(1);
    expect(output).toContain("FAILED");
    for (const agent of ["kb", "odoo", "hr"]) {
      expect(output).toContain(`[memory-heal]   ${agent}\n`);
    }
  });

  it.each([
    ["a rebuild that worked", {}],
    ["a rebuild that failed", { indexHeals: false }],
  ])("stops any llama-server the CLI left behind after %s", (_label, stub) => {
    // A rebuild the budget kills gets SIGTERM, so the CLI's exit hook never
    // stops the llama-server it spawned in its own process group. The gateway
    // would find it healthy on the provider port and reuse a server it does
    // not own and never idle-stops.
    setIdentities({ kb: "mismatched" });
    stubOpenclaw(stub);

    run();

    expect(pkillCalls()).toEqual([["-x", "llama-server"]]);
  });

  it("waits for the llama-server to exit before the gateway starts", () => {
    // SIGTERM is not instant: the router stops its model children first,
    // measured at several seconds on the RC image. A gateway started in
    // between still finds it healthy and reuses it.
    setIdentities({ kb: "mismatched" });
    stubPkill(3);

    run();

    expect(pkillCalls()).toEqual([
      ["-x", "llama-server"],
      ["-0", "-x", "llama-server"],
      ["-0", "-x", "llama-server"],
      ["-0", "-x", "llama-server"],
    ]);
  });

  it("kills a llama-server that outlives the grace period", () => {
    setIdentities({ kb: "mismatched" });
    stubPkill(1000);

    const output = run({ OPENCLAW_LLAMA_SERVER_STOP_TIMEOUT: "1" });

    expect(pkillCalls().at(-1)).toEqual(["-KILL", "-x", "llama-server"]);
    expect(output).toContain("llama-server did not stop within 1s");
  });

  it("leaves llama-server alone when nothing was rebuilt", () => {
    setIdentities({ smithers: "valid" });

    run();

    expect(pkillCalls()).toEqual([]);
  });

  it("reads the status past log lines printed before the JSON", () => {
    setIdentities({ kb: "mismatched" });
    stubOpenclaw({ statusPrefix: "[plugins] registered pinchy-files\\n" });

    run();

    expect(indexCalls()).toEqual([["memory", "index", "--agent", "kb"]]);
  });

  it("starts the gateway anyway when the status cannot be read", () => {
    setIdentities({ kb: "mismatched" });
    stubOpenclaw({ statusExit: 1 });

    const output = run();

    expect(indexCalls()).toEqual([]);
    expect(output).toContain("could not read the memory index status");
  });

  it("heals what a failing status still reports", () => {
    // One agent whose memory manager throws makes the whole command exit
    // non-zero, while the array it printed is complete for everyone else.
    // Skipping every agent over one would leave all of them broken.
    setIdentities({ kb: "mismatched", odoo: "mismatched" });
    stubOpenclaw({ statusExitAfterPrint: 1 });

    const output = run();

    expect(indexCalls()).toEqual([
      ["memory", "index", "--agent", "kb"],
      ["memory", "index", "--agent", "odoo"],
    ]);
    expect(output).not.toContain("could not read the memory index status");
  });

  it.each([
    ["an entry without an index identity", '[{"agentId":"kb","status":{}}]\\n'],
    ["no JSON at all", "Memory search disabled.\\n"],
    ["a JSON object instead of the array", '{"agents":[]}\\n'],
  ])("treats %s as unreadable, not as healthy", (_label, rawStatus) => {
    // A renamed field must not read as "nothing is mismatched": that is the
    // quiet green that would leave every broken index broken.
    stubOpenclaw({ rawStatus });

    const output = run();

    expect(indexCalls()).toEqual([]);
    expect(output).toContain("could not read the memory index status");
  });

  it("stops rebuilding when the time budget is used up", () => {
    setIdentities({ kb: "mismatched", odoo: "mismatched" });

    const output = run({ OPENCLAW_MEMORY_HEAL_BUDGET: "0" });

    expect(indexCalls()).toEqual([]);
    expect(output).toContain("Time budget of 0s used up");
    expect(output).toContain("FAILED");
  });

  it.each([
    ["OPENCLAW_MEMORY_HEAL_BUDGET"],
    ["OPENCLAW_MEMORY_STATUS_TIMEOUT"],
    ["OPENCLAW_LLAMA_SERVER_STOP_TIMEOUT"],
  ])("falls back to the default when %s is not a whole number of seconds", (name) => {
    // "15m" in $(( )) is a syntax error, and start-openclaw.sh runs under
    // `set -e`: the container would restart-loop over a typo in an env var.
    setIdentities({ kb: "mismatched" });

    const output = run({ [name]: "15m" });

    expect(output).toContain(`${name}="15m" is not a whole number of seconds`);
    expect(indexCalls()).toEqual([["memory", "index", "--agent", "kb"]]);
    expect(output).toMatch(/Memory indexes rebuilt in \d+s/);
  });

  it("does nothing before Pinchy has written a config", () => {
    rmSync(join(stateDir, "openclaw.json"));
    setIdentities({ kb: "mismatched" });

    run();

    expect(calls()).toEqual([]);
  });
});

describe("heal_memory_indexes — wiring", () => {
  // An extracted script that never reaches the container heals nothing, and
  // the tests above would stay green the whole time.
  const startScript = () => readFileSync(resolve(REPO_ROOT, "config/start-openclaw.sh"), "utf8");
  const lineOf = (lines: string[], re: RegExp) => lines.findIndex((l) => re.test(l));

  it("is sourced by start-openclaw.sh", () => {
    expect(startScript()).toContain("source /heal-memory-indexes.sh");
  });

  it("runs before the first gateway start, after the state migration", () => {
    // Before the gateway: the CLI's llama-server would otherwise share the
    // provider's port with the gateway's and vanish under it mid-embed. After
    // the migration: on an upgraded install the CLI reads migrated state.
    const lines = startScript().split("\n");
    const heal = lineOf(lines, /^\s*heal_memory_indexes\s*$/);
    const migrate = lineOf(lines, /^\s*migrate_legacy_openclaw_state\s*$/);
    const gateway = lineOf(lines, /^\s*openclaw gateway\b/);
    expect(heal).toBeGreaterThan(migrate);
    expect(heal).toBeLessThan(gateway);
  });

  it("runs before the device auto-approver starts its clock", () => {
    // auto_approve_devices gives up 5 minutes after it starts; a long rebuild
    // in front of the gateway must not use that up.
    const lines = startScript().split("\n");
    const heal = lineOf(lines, /^\s*heal_memory_indexes\s*$/);
    const approver = lineOf(lines, /^\s*auto_approve_devices &/);
    expect(heal).toBeGreaterThanOrEqual(0);
    expect(approver).toBeGreaterThan(heal);
  });

  it("is copied into the OpenClaw image", () => {
    const dockerfile = readFileSync(resolve(REPO_ROOT, "Dockerfile.openclaw"), "utf8");
    expect(dockerfile).toContain("COPY config/heal-memory-indexes.sh /heal-memory-indexes.sh");
  });
});
