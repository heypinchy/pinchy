// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// pinned-fetch.ts imports `undici` at load time, so whatever that module does
// on load, it does to the whole OpenClaw process. undici 8 reads only the `.2`
// global-dispatcher slot, which Node 22's bundled undici never sets — so it
// installs a fresh Agent and overwrites the `.1` slot Node's global fetch
// reads. Every plain fetch() in the process then bypasses the dispatcher Node
// configured, including the EnvHttpProxyAgent an operator gets from
// NODE_USE_ENV_PROXY=1 + HTTPS_PROXY. pinchy-odoo pins undici 7 for that
// reason, as pinchy-web does; this is the same guard as
// pinchy-web/global-dispatcher.test.ts, against this plugin's own copy.
//
// Measured in a child process: a vitest worker shares one process across
// files, so another file may already have loaded undici and an in-process check
// could read "unchanged" only because the damage happened earlier.

const undiciEntry = createRequire(path.join(__dirname, "..", "pinned-fetch.ts")).resolve("undici");

const probe = `
const slot = Symbol.for("undici.globalDispatcher.1");
const sentinel = { name: "the dispatcher Node configured" };
globalThis[slot] = sentinel;
require(process.argv[1]);
process.stdout.write(globalThis[slot] === sentinel ? "unchanged" : "replaced:" + (globalThis[slot] && globalThis[slot].constructor.name));
`;

describe("loading pinchy-odoo's undici", () => {
  it("leaves Node's global fetch dispatcher alone", () => {
    const out = execFileSync(process.execPath, ["-e", probe, undiciEntry], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    expect(out).toBe("unchanged");
  });
});
