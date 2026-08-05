// packages/web/src/__tests__/security/server-request-gates.test.ts
//
// The domain lock and the CSRF gate run in `server.ts`'s request handler, and
// nothing else in the suite proves they are still wired there.
//
// That used to be structurally safe: the host check was ~30 lines written
// inline, too conspicuous to drop by accident. #599 moved it behind
// `applyDomainLockGate(req, res)` so the gate and its audit trail could be
// tested without booting the app — which is worth having, but it also turned
// "delete the domain lock" into a one-line edit that leaves every unit test
// green. Both gate modules would still pass their own suites in full.
//
// No integration test covers the gap either, and cannot cheaply: every E2E
// stack configures no domain, so `getCachedDomain()` returns null and the host
// check is inert in all of them (see AGENTS.md § "`/api/internal/` Is A
// Security Claim, Not A Folder Name").
//
// Known limitation, stated plainly: this reads the source text. It proves the
// calls are present and ordered, not that the server the container runs was
// built from this file. It is a tripwire against an accidental deletion, which
// is the failure that actually happens.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVER_TS = resolve(__dirname, "../../../server.ts");
const source = readFileSync(SERVER_TS, "utf8");

describe("server.ts request gates", () => {
  it.each([
    ["domain lock", "applyDomainLockGate", "src/server/host-check.ts"],
    ["CSRF", "applyCsrfGate", "src/server/csrf-check.ts"],
  ])("invokes the %s gate and returns on a block", (_label, fn, module) => {
    // Matched on the `(req, res` prefix rather than the whole argument list:
    // the gates take a third argument since #825 and may take a fourth, and a
    // tripwire that has to be edited for every added parameter invites being
    // loosened in a hurry. The prefix still pins what this file is about — the
    // call is present, on the request, in the handler.
    expect(
      source.includes(`await ${fn}(req, res`),
      `server.ts does not await ${fn}(req, res, …). Every request must pass this gate before ` +
        `Next handles it — ${module} passing its own tests says nothing if nothing calls it.`
    ).toBe(true);

    expect(
      new RegExp(`if\\s*\\(await ${fn}\\(req, res[^)]*\\)\\)\\s*return`).test(source),
      `server.ts calls ${fn} but does not return on a block. Both gates answer the request ` +
        `themselves and return true; ignoring that lets a rejected request reach Next anyway.`
    ).toBe(true);
  });

  it("checks the destination before the source", () => {
    // Domain lock first: "is this request addressed to us?" is a cheaper and
    // more fundamental question than "did it come from us?", and answering
    // them the other way round reports a foreign host as a CSRF failure.
    const lock = source.indexOf("await applyDomainLockGate(req, res");
    const csrf = source.indexOf("await applyCsrfGate(req, res");

    expect(lock).toBeGreaterThan(-1);
    expect(csrf).toBeGreaterThan(lock);
  });

  // #825. Same failure shape as the gates above, one step earlier: the stamp
  // is a single line, deleting it leaves client-ip.test.ts entirely green, and
  // the damage is silent — Better Auth falls back to reading `x-forwarded-for`
  // itself, so the sign-in throttle keeps working while being spoofable again.
  // It has to run BEFORE the gates, because it also strips a client-supplied
  // copy of the internal header and the gates' audit rows read its result.
  it("resolves the client address before the gates run", () => {
    const stamp = source.indexOf("stampClientIp(req.headers");
    const lock = source.indexOf("await applyDomainLockGate(req, res");

    expect(
      stamp,
      "server.ts does not call stampClientIp(req.headers, …). Without it the address the " +
        "sign-in throttle buckets by is whatever the sender put in X-Forwarded-For, and the " +
        "blocked-request audit rows record the proxy instead of the client."
    ).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(lock);
  });
});

// The upgrade handler is the *second* request-handling entry point, and the
// gates above never see it: `server.on("upgrade", ...)` is not the
// `createServer` handler. That gap is not hypothetical — it is the bug #1056
// fixed, and for the whole life of the domain lock a locked instance still
// accepted WebSocket upgrades addressed to its raw IP.
//
// The fix has the same shape as the one that made the block above necessary:
// one call to a module that passes its own suite regardless. Deleting
// `isWsUpgradeAllowed` from server.ts leaves ws-upgrade-gate.test.ts entirely
// green, so the same tripwire has to cover the same failure here.
describe("server.ts WebSocket upgrade gate", () => {
  it("checks the upgrade before any auth work", () => {
    expect(
      source.includes("isWsUpgradeAllowed("),
      "server.ts does not call isWsUpgradeAllowed. The upgrade handler is a separate entry " +
        "point from the createServer handler — applyDomainLockGate/applyCsrfGate never see a " +
        "WebSocket handshake, so src/server/ws-upgrade-gate.ts passing its own tests says " +
        "nothing if nothing calls it."
    ).toBe(true);

    const gate = source.indexOf("isWsUpgradeAllowed(");
    const auth = source.indexOf("validateWsSession(");

    expect(auth).toBeGreaterThan(-1);
    expect(
      gate < auth,
      "server.ts validates the session cookie before the upgrade gate runs. A rejected " +
        "handshake must cost a header comparison, not a session lookup — and the domain " +
        "lock's guarantee is that a foreign host is answered before anything else happens."
    ).toBe(true);
  });

  it("rejects the handshake when the gate says no", () => {
    expect(
      /if\s*\(!upgradeCheck\.allowed\)/.test(source),
      "server.ts calls isWsUpgradeAllowed but does not branch on `!upgradeCheck.allowed`. " +
        "An unread verdict is the same as no gate at all."
    ).toBe(true);

    expect(
      source.includes('socket.write("HTTP/1.1 403 Forbidden\\r\\n\\r\\n")'),
      "server.ts does not answer a blocked upgrade with 403. Unlike the HTTP gates the " +
        "upgrade handler owns the raw socket, so it has to write the response itself."
    ).toBe(true);
  });
});
