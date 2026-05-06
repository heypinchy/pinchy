import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KNOWN_PINCHY_PLUGINS } from "@/lib/openclaw-config/plugin-manifest-loader";

const REPO_ROOT = resolve(__dirname, "../../../../../..");
const COMPOSE = readFileSync(resolve(REPO_ROOT, "docker-compose.integration.yml"), "utf8");

describe("docker-compose.integration.yml plugin coverage", () => {
  it.each(KNOWN_PINCHY_PLUGINS)("bind-mounts %s into OpenClaw extensions", (plugin) => {
    const expected = `./packages/plugins/${plugin}:/root/.openclaw/extensions/${plugin}`;
    expect(COMPOSE).toContain(expected);
  });
});
