/**
 * Regression test for Phase 4.2 (cold-start architecture):
 * OpenClaw's first "[gateway] ready" log line must appear AFTER
 * Pinchy's first "OpenClaw config regenerated from DB state" log line.
 *
 * Before Phase 4.2: pinchy depended on openclaw (service_started) and
 * openclaw started independently — it could become ready before Pinchy
 * had written the final config, causing a SIGUSR1 restart cascade (~117s
 * of "agent unavailable").
 *
 * After Phase 4.2: openclaw depends on pinchy (service_healthy), and
 * Pinchy's healthcheck only passes after regenerateOpenClawConfig()
 * completes — so OpenClaw always boots from the final config.
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { resolve } from "path";
import { waitForPinchy } from "./helpers";

const REPO_ROOT = resolve(__dirname, "../../../..");
const COMPOSE_FILES = "-f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.test.yml";
const COMPOSE_ENV = { ...process.env, PINCHY_VERSION: process.env.PINCHY_VERSION || "local" };

function getLogsWithTimestamps(service: string): string {
  return execSync(`docker compose ${COMPOSE_FILES} logs ${service} --timestamps 2>&1`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: COMPOSE_ENV,
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Extract the first ISO timestamp from a log line.
// docker compose logs --timestamps format: "service  | 2026-05-03T15:34:29.123456789Z message"
function parseTimestampFromLine(line: string): Date | null {
  const match = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  if (!match) return null;
  return new Date(match[1] + "Z");
}

function findFirstTimestamp(logs: string, searchStr: string): Date | null {
  const line = logs.split("\n").find((l) => l.includes(searchStr));
  if (!line) return null;
  return parseTimestampFromLine(line);
}

test.describe.serial("Cold-start ordering — OpenClaw boots after Pinchy config is written", () => {
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(120000);
    await waitForPinchy();
  });

  test("OpenClaw [gateway] ready appears after Pinchy signals boot complete", async () => {
    const pinchyLogs = getLogsWithTimestamps("pinchy");
    const openclawLogs = getLogsWithTimestamps("openclaw");

    // Pinchy logs this unconditionally at the end of bootInits(), immediately
    // before markOpenClawConfigReady() is called. Because openclaw depends on
    // pinchy's healthcheck (which polls /api/internal/openclaw-config-ready),
    // OpenClaw cannot start until after this log line is emitted.
    const bootCompleteAt = findFirstTimestamp(
      pinchyLogs,
      "[pinchy] boot complete: OpenClaw container may now start"
    );
    expect(
      bootCompleteAt,
      "Pinchy must log '[pinchy] boot complete: OpenClaw container may now start' with a timestamp"
    ).not.toBeNull();

    // OC 4.27 logs "[gateway] ready" without trailing parentheses.
    const gatewayReadyAt = findFirstTimestamp(openclawLogs, "[gateway] ready");
    expect(gatewayReadyAt, "OpenClaw must log '[gateway] ready' with a timestamp").not.toBeNull();

    expect(
      gatewayReadyAt!.getTime(),
      `OpenClaw reported ready at ${gatewayReadyAt!.toISOString()} but ` +
        `Pinchy signaled boot complete at ${bootCompleteAt!.toISOString()}. ` +
        `OpenClaw must not become ready before Pinchy has signaled it may start. ` +
        `Check that docker-compose.yml has openclaw.depends_on.pinchy.condition: service_healthy.`
    ).toBeGreaterThanOrEqual(bootCompleteAt!.getTime());
  });
});
