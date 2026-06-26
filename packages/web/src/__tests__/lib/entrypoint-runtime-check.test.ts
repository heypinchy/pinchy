import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KNOWN_PINCHY_PLUGINS } from "@/lib/openclaw-config/plugin-manifest-loader";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const ENTRYPOINT = readFileSync(resolve(REPO_ROOT, "entrypoint.sh"), "utf8");

describe("entrypoint.sh plugin runtime check", () => {
  it("hardcodes EXACTLY the KNOWN_PINCHY_PLUGINS list (no missing, no stale extras)", () => {
    const match = ENTRYPOINT.match(/EXPECTED_PLUGINS="([^"]*)"/);
    expect(match, "EXPECTED_PLUGINS assignment not found in entrypoint.sh").not.toBeNull();
    const listed = match![1].trim().split(/\s+/).filter(Boolean).sort();
    const known = [...KNOWN_PINCHY_PLUGINS].sort();
    // Bidirectional, not just KNOWN ⊆ entrypoint: a MISSING plugin breaks tool
    // loading, but a STALE EXTRA (a removed plugin still listed here) makes the
    // `set -e` guard below FATAL on a directory the image no longer ships — the
    // whole stack then fails to boot (the pinchy-mcp removal incident, 2026-06).
    expect(listed).toEqual(known);
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

describe("plugin-source sync preserves node_modules (PR #275 regression guard)", () => {
  const SYNC_PLUGINS = readFileSync(resolve(REPO_ROOT, "config/sync-plugins.sh"), "utf8");

  it("entrypoint delegates the plugin-source sync to sync-plugins.sh", () => {
    expect(ENTRYPOINT).toContain("/sync-plugins.sh");
  });

  it("excludes node_modules from change-detection", () => {
    // node_modules is installed by the OpenClaw container, not shipped in the
    // image source. Including it in the diff makes the sync ALWAYS differ and
    // re-run, which is what destroyed the deps in #275.
    expect(SYNC_PLUGINS).toMatch(/diff\b[^\n]*--exclude=node_modules/);
  });

  it("replaces stale source without ever deleting node_modules", () => {
    // The fix: delete only non-node_modules entries, never `rm -rf` the whole
    // plugin dir (the #275 bug that wiped OpenClaw-installed deps and broke
    // pinchy-web / pinchy-files / pinchy-odoo on a pinchy-only restart).
    expect(SYNC_PLUGINS).toMatch(/!\s+-name\s+node_modules/);
    expect(SYNC_PLUGINS).not.toMatch(/rm\s+-rf\s+"\$plugin_dst"/);
  });
});
