import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const installingHtml = readFileSync(
  resolve(__dirname, "../../../../../docs/public/installing.html"),
  "utf-8"
);

describe("installing.html — robust loading page", () => {
  it("does not use <meta http-equiv='refresh'> so brief Caddy/Pinchy outages never trigger a hard reload", () => {
    // The old design had `<meta http-equiv="refresh" content="20">`. Every 20s
    // the browser itself would re-request the URL; if Caddy was mid-restart or
    // Pinchy was mid-boot during that re-request, the browser showed
    // ERR_CONNECTION_REFUSED and the user thought the install had crashed.
    // JS-based polling stays on the page through transient outages.
    expect(installingHtml).not.toMatch(/<meta[^>]*http-equiv\s*=\s*["']refresh["']/i);
  });

  it("polls /api/health via fetch so it can detect when Pinchy becomes ready", () => {
    // /api/health returns 200 only when Caddy successfully proxies to Pinchy
    // (primary upstream healthy). During fallback (Pinchy not up), the :9999
    // block responds 503 for /api/*. Network errors mean Caddy itself is
    // mid-restart. Only 200 means we can safely reload and land on Pinchy.
    expect(installingHtml).toMatch(/fetch\(\s*["'`]\/api\/health/);
  });

  it("reloads the page when /api/health signals readiness", () => {
    // On a truthy ok/200 response, the page reloads — the next request goes
    // through Caddy's primary upstream and lands on Pinchy's home page.
    expect(installingHtml).toMatch(/location\.reload\(\)/);
  });

  it("does not redirect to an external origin (trust the same Caddy instance only)", () => {
    // Hardcoding a redirect to an external URL would break air-gapped installs
    // and could leak installation telemetry. The reload pattern keeps users on
    // whatever origin they typed into the browser.
    expect(installingHtml).not.toMatch(/location\.(?:href|replace)\s*=\s*["'`]https?:\/\//i);
  });

  it("is a self-contained single file with no external script sources", () => {
    // The cloud-init curls this file once at boot and serves it from the VPS.
    // External <script src=...> would add a runtime dependency on the
    // internet after install — fragile for locked-down networks.
    expect(installingHtml).not.toMatch(/<script[^>]+src\s*=/i);
  });

  it("keeps polling on fetch failure rather than giving up (covers Caddy restarts)", () => {
    // The polling loop must catch fetch rejections and keep running. If the
    // try/catch is missing or the setInterval gets cleared on error, the page
    // would silently stop checking and never recover.
    expect(installingHtml).toMatch(/catch\s*\(/);
    expect(installingHtml).toMatch(/setInterval/);
  });
});
