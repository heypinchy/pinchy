import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KNOWN_PINCHY_PLUGINS } from "@/lib/openclaw-config/plugin-manifest-loader";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const ENTRYPOINT = readFileSync(resolve(REPO_ROOT, "entrypoint.sh"), "utf8");

describe("entrypoint.sh plugin runtime check", () => {
  it("hardcodes the expected-plugin list", () => {
    for (const plugin of KNOWN_PINCHY_PLUGINS) {
      expect(ENTRYPOINT).toContain(plugin);
    }
  });

  it("fails fast (exit 1) if a plugin directory is missing", () => {
    expect(ENTRYPOINT).toMatch(/exit 1/);
    expect(ENTRYPOINT).toMatch(/openclaw-extensions/);
  });
});

describe("entrypoint.sh Secure-cookie (domain-lock) reconcile", () => {
  it("runs the domain-lock reconciler before starting the server", () => {
    expect(ENTRYPOINT).toContain("reconcile-domain-lock-flag.mjs");
  });

  it("reconciles AFTER migrations (settings table exists) and BEFORE the server boots", () => {
    // auth.ts reads the flag at import; the server must not start until the
    // flag reflects the DB `domain` setting, and the settings table must be
    // migrated first. Order: db:migrate -> reconcile -> pnpm start.
    const migrate = ENTRYPOINT.indexOf("db:migrate");
    const reconcile = ENTRYPOINT.indexOf("reconcile-domain-lock-flag.mjs");
    const start = ENTRYPOINT.lastIndexOf("pnpm start");
    expect(migrate).toBeGreaterThanOrEqual(0);
    expect(reconcile).toBeGreaterThan(migrate);
    expect(start).toBeGreaterThan(reconcile);
  });

  it("never blocks the boot if the reconcile fails", () => {
    // The reconcile invocation must be non-fatal (degrades to non-Secure
    // cookies; login still works) — guarded by a trailing `|| true`.
    expect(ENTRYPOINT).toMatch(/reconcile-domain-lock-flag\.mjs'\s*\|\|\s*true/);
  });
});
