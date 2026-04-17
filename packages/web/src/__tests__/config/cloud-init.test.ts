import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const cloudInitPath = resolve(__dirname, "../../../../../docs/src/snippets/cloud-init.yml");
const composePath = resolve(__dirname, "../../../../../docker-compose.yml");

describe("cloud-init.yml", () => {
  const cloudInit = readFileSync(cloudInitPath, "utf-8");
  const compose = readFileSync(composePath, "utf-8");

  it("writes a PINCHY_PORT that stays a valid docker port spec after compose expansion", () => {
    // docker-compose.yml wraps PINCHY_PORT as "${PINCHY_PORT:-default}:7777".
    // Docker parses port specs with 1, 2, or 3 colon-separated parts:
    //   "7777"              → CONTAINER only
    //   "HOST:CONTAINER"    → HOST_PORT:CONTAINER_PORT
    //   "IP:HOST:CONTAINER" → HOST_IP:HOST_PORT:CONTAINER_PORT
    // If PINCHY_PORT already contains a colon, the wrapped value has three
    // parts and docker treats the first segment as a HOST_IP — which must be
    // a valid IP or compose errors with "invalid IP address".
    // Regression: a PINCHY_PORT=80:7777 cloud-init wrote expanded to
    // "80:7777:7777", crashing docker compose with "invalid IP address: 80".

    // Verify the wrapping pattern is still what we assume.
    expect(compose).toMatch(/\$\{PINCHY_PORT:-[^}]+\}:7777/);

    const match = cloudInit.match(/PINCHY_PORT=([^\s"]+)/);
    expect(match).not.toBeNull();
    const pinchyPort = match![1];

    if (pinchyPort.includes(":")) {
      const hostIp = pinchyPort.split(":")[0];
      expect(hostIp).toMatch(/^(\d{1,3}\.){3}\d{1,3}$/);
    }
  });
});
