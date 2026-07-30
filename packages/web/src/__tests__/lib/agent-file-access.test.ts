/**
 * Defense in depth for the file-serving boundary.
 *
 * `resolveAllowedFile` used to measure containment ONLY against the agent's
 * `allowed_paths`, on the stated assumption that the list is
 * "admin-configured". It was not: `PATCH /api/agents/[id]` accepted
 * `pluginConfig` from any member who owns the agent, and every user owns a
 * seeded personal one. The write side is clamped now (see
 * `domain-validation.test.ts`), but a clamp on new writes says nothing about
 * rows already in the database — an 0.8 install could carry an
 * admin-configured `/etc` grant, and a poisoned row written before the clamp
 * would otherwise stay exploitable across the upgrade that fixes it.
 *
 * So the reader carries its own absolute ceiling, exactly as
 * `packages/plugins/pinchy-files/validate.ts` does with `ALLOWED_ROOTS`.
 * The ceiling is passed in here rather than hard-coded, because the two
 * containers mount the same volumes at different paths and the production
 * value is therefore not a constant the tests can create on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAllowedFile, FILE_SERVE_ROOTS } from "@/lib/agent-file-access";

let tmpRoot: string;
let serveRoot: string;
let insideFile: string;
let outsideDir: string;
let outsideFile: string;

beforeEach(() => {
  // realpath: on macOS /var is a symlink to /private/var, and the ceiling
  // check compares real paths.
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "pinchy-file-ceiling-")));
  serveRoot = join(tmpRoot, "data");
  outsideDir = join(tmpRoot, "secrets");
  mkdirSync(serveRoot, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  insideFile = join(serveRoot, "invoice.pdf");
  outsideFile = join(outsideDir, "master.key");
  writeFileSync(insideFile, "%PDF-1.4\n");
  writeFileSync(outsideFile, "AES master key");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveAllowedFile — absolute serve-root ceiling", () => {
  it("serves a file that is inside both the allowlist and the ceiling", async () => {
    const res = await resolveAllowedFile(insideFile, [serveRoot], [serveRoot]);
    expect(res).toEqual({ ok: true, realPath: insideFile });
  });

  it("refuses a file outside the ceiling even when the allowlist says the filesystem root", async () => {
    const res = await resolveAllowedFile(outsideFile, ["/"], [serveRoot]);
    expect(res).toEqual({ ok: false, status: 403 });
  });

  it("still serves an in-ceiling file when the allowlist is that same over-broad root", async () => {
    // The ceiling removes the escape; it must not break the grant itself,
    // or an upgrade would 403 every legitimate citation on such an install.
    const res = await resolveAllowedFile(insideFile, ["/"], [serveRoot]);
    expect(res).toEqual({ ok: true, realPath: insideFile });
  });

  it("refuses a grant that lies wholly outside the ceiling", async () => {
    const res = await resolveAllowedFile(outsideFile, [outsideDir], [serveRoot]);
    expect(res).toEqual({ ok: false, status: 403 });
  });

  it("applies the ceiling to the real path, not just the lexical one", async () => {
    // A symlink planted inside the served root pointing at the secret. The
    // allowlist and the lexical path both look fine; only the realpath stage
    // can see the escape, so the ceiling has to be enforced there too.
    const trap = join(serveRoot, "looks-innocent.pdf");
    symlinkSync(outsideFile, trap);
    const res = await resolveAllowedFile(trap, ["/"], [serveRoot]);
    expect(res).toEqual({ ok: false, status: 403 });
  });

  it("reports a missing in-scope path as 404, so the ceiling adds no new oracle", async () => {
    const res = await resolveAllowedFile(join(serveRoot, "nope.pdf"), [serveRoot], [serveRoot]);
    expect(res).toEqual({ ok: false, status: 404 });
  });

  it("reports a missing OUT-of-ceiling path as 403, never 404", async () => {
    // A 404 here would tell an attacker which paths outside the ceiling
    // exist — the same reason out-of-allowlist paths already 403.
    const res = await resolveAllowedFile(join(outsideDir, "nope.key"), ["/"], [serveRoot]);
    expect(res).toEqual({ ok: false, status: 403 });
  });

  it("denies everything when the ceiling is empty rather than falling open", async () => {
    const res = await resolveAllowedFile(insideFile, [serveRoot], []);
    expect(res).toEqual({ ok: false, status: 403 });
  });

  it("keeps denying an empty allowlist", async () => {
    const res = await resolveAllowedFile(insideFile, [], [serveRoot]);
    expect(res).toEqual({ ok: false, status: 403 });
  });
});

describe("FILE_SERVE_ROOTS", () => {
  it("is /data/ and nothing else", () => {
    // Deliberately NOT the plugin's ALLOWED_ROOTS. In the pinchy container
    // the workspaces volume is mounted at /openclaw-config/workspaces, so
    // copying the plugin's "/root/.openclaw/workspaces/" would be dead
    // weight — and admitting its parent /openclaw-config would hand out
    // openclaw.json, which carries the plaintext gateway token.
    expect(FILE_SERVE_ROOTS).toEqual(["/data/"]);
  });
});
