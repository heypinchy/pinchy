// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// web-fetch.ts imports `undici` at load time, so whatever that module does on
// load, it does to the whole OpenClaw process. undici 8 reads only the `.2`
// global-dispatcher slot, which Node 22's bundled undici never sets — so it
// installs a fresh Agent and overwrites the `.1` slot Node's global fetch
// reads. Every plain fetch() in the process then bypasses the dispatcher Node
// configured, including the EnvHttpProxyAgent an operator gets from
// NODE_USE_ENV_PROXY=1 + HTTPS_PROXY.
//
// Inside today's gateway this is masked, not absent: OpenClaw carries undici 8
// itself and its gateway re-installs an env-proxy dispatcher from HTTPS_PROXY
// before plugins load (measured for #1274). The plugin must not depend on that
// ordering, so it pins undici 7, which leaves a dispatcher it finds in place —
// the same pin packages/web carries for the same reason.
//
// Measured in a child process: a vitest worker shares one process across
// files, so another file may already have loaded undici and an in-process check
// could read "unchanged" only because the damage happened earlier.

const undiciEntry = createRequire(path.join(__dirname, "web-fetch.ts")).resolve("undici");

const probe = `
const slot = Symbol.for("undici.globalDispatcher.1");
const sentinel = { name: "the dispatcher Node configured" };
globalThis[slot] = sentinel;
require(process.argv[1]);
process.stdout.write(globalThis[slot] === sentinel ? "unchanged" : "replaced:" + (globalThis[slot] && globalThis[slot].constructor.name));
`;

describe("loading pinchy-web's undici", () => {
  it("leaves Node's global fetch dispatcher alone", () => {
    const out = execFileSync(process.execPath, ["-e", probe, undiciEntry], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    expect(out).toBe("unchanged");
  });
});
