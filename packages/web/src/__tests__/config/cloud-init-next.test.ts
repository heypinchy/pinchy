import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const cloudInitNextPath = resolve(__dirname, "../../../../../staging/cloud-init.yml");
const composePath = resolve(__dirname, "../../../../../docker-compose.yml");

describe("cloud-init-next.yml (staging)", () => {
  const cloudInit = readFileSync(cloudInitNextPath, "utf-8");
  const compose = readFileSync(composePath, "utf-8");

  it("pins PINCHY_VERSION to the moving `next` channel, not a release tag", () => {
    // Staging tracks the :next images that pre-release.yml builds on every
    // push to main. A pinned vX.Y.Z would defeat the purpose.
    expect(cloudInit).toMatch(/PINCHY_VERSION=next/);
    expect(cloudInit).not.toMatch(/PINCHY_VERSION=v\d/);
    expect(cloudInit).not.toMatch(/%%PINCHY_VERSION%%/);
  });

  it("fetches docker-compose.yml from the main branch, not a release tag", () => {
    // Same reason as above: we want the compose file that goes with the
    // current main HEAD, not a frozen release.
    expect(cloudInit).toMatch(
      /raw\.githubusercontent\.com\/heypinchy\/pinchy\/main\/docker-compose\.yml/
    );
  });

  it("installs Caddy from the official Cloudsmith apt repository", () => {
    expect(cloudInit).toMatch(/dl\.cloudsmith\.io\/public\/caddy\/stable\/gpg\.key/);
    expect(cloudInit).toMatch(/dl\.cloudsmith\.io\/public\/caddy\/stable\/debian\.deb\.txt/);
    expect(cloudInit).toMatch(/apt-get install[^\n]*\bcaddy\b/);
  });

  it("does not use python3 http.server as a loading-page shim", () => {
    // Same regression guard as the prod cloud-init — the python http.server
    // shim left a 30-60s gap on port 80 between killing the loader and
    // starting Pinchy. Caddy stays up through the transition.
    expect(cloudInit).not.toMatch(/python3 -m http\.server/);
    expect(cloudInit).not.toMatch(/loading-server\.pid/);
  });

  it("writes a Caddyfile that reverse_proxies to Pinchy with a loading-page fallback (matches prod)", () => {
    // Staging mirrors prod's Caddy design so the same plumbing is exercised
    // end-to-end before each release. The loading page covers the cold-start
    // window where Pinchy is unreachable (initial pull, JIT compile, restart);
    // lb_policy first → primary preferred, fall back only when unreachable.
    expect(cloudInit).toMatch(/reverse_proxy\s+127\.0\.0\.1:7777\s+127\.0\.0\.1:9999/);
    expect(cloudInit).toMatch(/lb_policy\s+first/);
    expect(cloudInit).toMatch(/lb_try_duration\s+1s/);
    expect(cloudInit).toMatch(/fail_duration\s+\d+s/);
  });

  it("binds the fallback loading-page server to localhost only", () => {
    // The :9999 upstream is a Caddy-internal fallback — exposing it publicly
    // would leak the raw loading page on its own port.
    expect(cloudInit).toMatch(/bind\s+127\.0\.0\.1/);
  });

  it("serves the loading page from a Caddy-accessible web root", () => {
    expect(cloudInit).toMatch(/\/var\/www\/pinchy-loading\/index\.html/);
    expect(cloudInit).toMatch(/file_server/);
  });

  it("fetches installing.html from the latest release (no version-tag pinning needed)", () => {
    // GitHub redirects /releases/latest/download/<asset> to whatever the
    // most recent release ships. Using `latest` instead of a hard-coded
    // version means we don't have to bump this file every time we release.
    expect(cloudInit).toMatch(
      /github\.com\/heypinchy\/pinchy\/releases\/latest\/download\/installing\.html/
    );
    expect(cloudInit).not.toMatch(/releases\/download\/v\d/);
  });

  it("does not override PINCHY_PORT so Pinchy keeps the secure 127.0.0.1:7777 default", () => {
    expect(cloudInit).not.toMatch(/PINCHY_PORT=/);
    expect(compose).toMatch(/\$\{PINCHY_PORT:-127\.0\.0\.1:7777\}:7777/);
  });

  it("enables and starts Caddy via systemd so it restarts on reboot", () => {
    expect(cloudInit).toMatch(/systemctl\s+(enable|restart|reload)[^\n]*caddy/);
  });

  it("installs caddy non-interactively so the pre-staged Caddyfile survives dpkg's conffile prompt", () => {
    // Same regression guard as the prod cloud-init — see cloud-init.test.ts
    // for the full incident description.
    const caddyInstallLines = cloudInit
      .split("\n")
      .filter((line) => /apt-get install[^\n]*\bcaddy\b/.test(line));
    expect(caddyInstallLines.length).toBeGreaterThan(0);
    for (const line of caddyInstallLines) {
      expect(line).toMatch(/--force-confold/);
    }
  });
});
