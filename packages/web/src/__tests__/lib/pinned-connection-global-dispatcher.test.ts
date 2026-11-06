import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// `pinned-connection.ts` is imported at boot (provider-url-guard → openclaw
// config build), so whatever its `undici` does at load time, it does to the
// whole process. undici 8 reads only the `.2` global-dispatcher slot, which
// Node 22's bundled undici never sets — so it installs a fresh Agent of its own
// and overwrites the `.1` slot Node's global fetch reads. Every plain fetch()
// in Pinchy then bypasses the dispatcher Node configured, including the
// EnvHttpProxyAgent an operator gets from NODE_USE_ENV_PROXY=1 + HTTPS_PROXY:
// the egress proxy is silently dropped.
//
// Measured in a child process, not by importing here: a vitest worker shares
// one process across files, Node caches the externalised `undici` module, and
// another file may already have loaded it — so an in-process check could
// read "unchanged" only because the damage happened earlier.

const webSrc = path.resolve(__dirname, "../../lib");
// The `undici` that `import ... from "undici"` in pinned-connection.ts gets.
const undiciEntry = createRequire(path.join(webSrc, "pinned-connection.ts")).resolve("undici");

const probe = `
const slot = Symbol.for("undici.globalDispatcher.1");
const sentinel = { name: "the dispatcher Node configured" };
globalThis[slot] = sentinel;
require(process.argv[1]);
process.stdout.write(globalThis[slot] === sentinel ? "unchanged" : "replaced:" + (globalThis[slot] && globalThis[slot].constructor.name));
`;

describe("loading pinned-connection's undici", () => {
  it("leaves Node's global fetch dispatcher alone", () => {
    const out = execFileSync(process.execPath, ["-e", probe, undiciEntry], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    expect(out).toBe("unchanged");
  });
});
