/**
 * Integration smoke test for OpenClaw cron wrappers (C7).
 *
 * Requires Docker OpenClaw running and the INTEGRATION_TEST env var set.
 * If cron.list / cron.add etc. are not available in the deployed OpenClaw
 * version, the test will fail with "method not found" — that's the signal
 * to upgrade OpenClaw.
 *
 * Run manually:
 *   INTEGRATION_TEST=1 OPENCLAW_WS_URL=ws://localhost:18789 OPENCLAW_GATEWAY_TOKEN=<token> \
 *     pnpm --filter web vitest run src/__tests__/integration/openclaw-cron.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { OpenClawClient } from "openclaw-node";
import { setOpenClawClient } from "@/server/openclaw-client";
import {
  upsertCronJob,
  removeCronJobByName,
  listCronJobs,
  listCronRuns,
  getCronStatus,
} from "@/server/openclaw-cron";

const OPENCLAW_WS_URL = process.env.OPENCLAW_WS_URL;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

describe
  .skipIf(!process.env.INTEGRATION_TEST)
  .sequential("openclaw cron wrappers (integration)", () => {
    const TEST_NAME = "pinchy-test-briefing-" + Math.random().toString(36).slice(2, 8);

    beforeAll(async () => {
      if (!OPENCLAW_WS_URL) {
        throw new Error(
          "OPENCLAW_WS_URL is required for integration tests (e.g. ws://localhost:18789)"
        );
      }
      const client = new OpenClawClient({
        url: OPENCLAW_WS_URL,
        token: OPENCLAW_GATEWAY_TOKEN,
        clientId: "pinchy-integration-test",
        clientVersion: "0.0.0",
        scopes: ["operator.admin"],
        autoReconnect: false,
      });
      setOpenClawClient(client);
      await client.connect();
    });

    afterEach(async () => {
      try {
        await removeCronJobByName(TEST_NAME);
      } catch {}
    });

    it("creates, finds, updates, removes a cron job", async () => {
      await upsertCronJob({
        name: TEST_NAME,
        agentId: "test-agent",
        schedule: { kind: "cron", expr: "0 0 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "test" },
      });
      const jobs1 = await listCronJobs({ namePrefix: TEST_NAME });
      expect(jobs1).toHaveLength(1);

      await upsertCronJob({
        name: TEST_NAME,
        agentId: "test-agent",
        schedule: { kind: "cron", expr: "0 1 * * *", tz: "Europe/Vienna" },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "updated" },
      });
      const jobs2 = await listCronJobs({ namePrefix: TEST_NAME });
      expect(jobs2).toHaveLength(1); // still just one (update, not add)

      await removeCronJobByName(TEST_NAME);
      const jobs3 = await listCronJobs({ namePrefix: TEST_NAME });
      expect(jobs3).toHaveLength(0);
    });

    it("cron.status returns counts", async () => {
      const status = await getCronStatus();
      expect(status).toHaveProperty("enabled");
      expect(status).toHaveProperty("disabled");
      expect(status).toHaveProperty("running");
      expect(typeof status.enabled).toBe("number");
    });

    it("cron.runs returns an array (possibly empty) for a fresh job", async () => {
      await upsertCronJob({
        name: TEST_NAME,
        agentId: "test-agent",
        schedule: { kind: "cron", expr: "0 0 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "test" },
      });
      const job = (await listCronJobs({ namePrefix: TEST_NAME }))[0];
      const runs = await listCronRuns({ jobId: job.id });
      expect(Array.isArray(runs)).toBe(true);
    });
  });
