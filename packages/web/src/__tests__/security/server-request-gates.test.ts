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
    expect(
      source.includes(`await ${fn}(req, res)`),
      `server.ts does not await ${fn}(req, res). Every request must pass this gate before ` +
        `Next handles it — ${module} passing its own tests says nothing if nothing calls it.`
    ).toBe(true);

    expect(
      new RegExp(`if\\s*\\(await ${fn}\\(req, res\\)\\)\\s*return`).test(source),
      `server.ts calls ${fn} but does not return on a block. Both gates answer the request ` +
        `themselves and return true; ignoring that lets a rejected request reach Next anyway.`
    ).toBe(true);
  });

  it("checks the destination before the source", () => {
    // Domain lock first: "is this request addressed to us?" is a cheaper and
    // more fundamental question than "did it come from us?", and answering
    // them the other way round reports a foreign host as a CSRF failure.
    const lock = source.indexOf("await applyDomainLockGate(req, res)");
    const csrf = source.indexOf("await applyCsrfGate(req, res)");

    expect(lock).toBeGreaterThan(-1);
    expect(csrf).toBeGreaterThan(lock);
  });
});
