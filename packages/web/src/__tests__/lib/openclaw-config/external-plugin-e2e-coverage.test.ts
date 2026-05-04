import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXTERNAL_INTEGRATION_PLUGINS } from "@/lib/openclaw-config/plugin-manifest-loader";

const REPO_ROOT = resolve(__dirname, "../../../../../..");
const CI = readFileSync(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

// pinchy-<suffix> → <suffix> (matches existing odoo-e2e job naming)
function suffix(id: string): string {
  return id.replace(/^pinchy-/, "");
}

describe("external integration plugins have full E2E coverage", () => {
  it.each(EXTERNAL_INTEGRATION_PLUGINS)("%s has a Playwright config", (id) => {
    const path = resolve(REPO_ROOT, `packages/web/playwright.${suffix(id)}.config.ts`);
    expect(existsSync(path), `missing ${path}`).toBe(true);
  });

  it.each(EXTERNAL_INTEGRATION_PLUGINS)("%s has a Playwright spec directory", (id) => {
    const path = resolve(REPO_ROOT, `packages/web/e2e/${suffix(id)}`);
    expect(existsSync(path), `missing ${path}`).toBe(true);
  });

  it.each(EXTERNAL_INTEGRATION_PLUGINS)("%s has a docker-compose mock overlay", (id) => {
    const path = resolve(REPO_ROOT, `docker-compose.${suffix(id)}-test.yml`);
    expect(existsSync(path), `missing ${path}`).toBe(true);
  });

  it.each(EXTERNAL_INTEGRATION_PLUGINS)("%s has a CI job named <suffix>-e2e", (id) => {
    const jobName = `${suffix(id)}-e2e:`;
    expect(CI).toContain(jobName);
  });

  it.each(EXTERNAL_INTEGRATION_PLUGINS)("%s has a test:e2e:<suffix> npm script", (id) => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "packages/web/package.json"), "utf8"));
    expect(pkg.scripts).toHaveProperty(`test:e2e:${suffix(id)}`);
  });
});
