import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, join } from "path";

const SW_PATH = join(resolve(__dirname, "../../../../public"), "sw.js");

describe("service worker stub", () => {
  const source = readFileSync(SW_PATH, "utf-8");

  it("calls skipWaiting() on install (so updates activate immediately)", () => {
    expect(source).toMatch(/skipWaiting\s*\(/);
  });

  it("claims clients on activate (so update propagates to open tabs)", () => {
    expect(source).toMatch(/clients\.claim\s*\(/);
  });

  it("registers a fetch listener (required for Chrome installability check)", () => {
    expect(source).toMatch(/addEventListener\s*\(\s*['"]fetch['"]/);
  });

  it("imports the share-target handler module", () => {
    expect(source).toMatch(/importScripts\s*\(\s*["']\/sw-share-target\.js["']\s*\)/);
  });

  it("only intercepts POST /share-target, delegating to handleShareTarget, and lets everything else pass through", () => {
    expect(source).toMatch(/\/share-target/);
    expect(source).toMatch(/handleShareTarget/);

    const fetchStart = source.search(/addEventListener\s*\(\s*["']fetch["']/);
    expect(fetchStart).toBeGreaterThanOrEqual(0);
    const fetchBody = source.slice(fetchStart);

    // The only respondWith() call must live inside an if-block that guards
    // on both the POST method and the /share-target path -- this is what
    // would fail if someone made the handler intercept every request.
    const guardMatch = fetchBody.match(
      /if\s*\([^{]*method\s*===\s*["']POST["'][^{]*\/share-target[^{]*\)\s*\{([\s\S]*?)\}/
    );
    expect(guardMatch).not.toBeNull();
    const guardedBlock = guardMatch![1];
    expect(guardedBlock).toMatch(/respondWith\s*\(\s*handleShareTarget/);

    const bodyOutsideGuard = fetchBody.replace(guardMatch![0], "");
    expect(bodyOutsideGuard).not.toMatch(/respondWith\s*\(/);
  });

  it("keeps claiming clients and sweeps orphaned share-target cache entries on activate", () => {
    expect(source).toMatch(/clients\.claim\s*\(/);
    expect(source).toMatch(/caches\.open\s*\(\s*["']share-target["']\s*\)/);
  });
});
