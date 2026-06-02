/**
 * Tier-2 usage tracking — internal usage endpoint (the plugin/vision path).
 *
 * The usage-tracking test pyramid has two write paths into `usage_records`:
 *
 *   1. The poller delta path — reads OpenClaw's per-session cumulative token
 *      counters and records deltas. Proving that path stays in sync with
 *      OpenClaw requires a REAL gateway: `openclaw-node@0.11.0` types
 *      `sessions.list()` as `Promise<Record<string, unknown>>`, so a faked
 *      client would only validate Pinchy's own assumption about the wire
 *      format against itself (a false-green if OpenClaw's shape drifts). That
 *      path is therefore covered at the E2E layer, against real Docker
 *      OpenClaw + fake-ollama, in `e2e/integration/usage-tracking.spec.ts`
 *      (issue #426 cases 1 & 2).
 *
 *   2. The internal usage endpoint — `POST /api/internal/usage/record`, the
 *      sink Pinchy plugins use to report LLM tokens spent outside an agent
 *      session (e.g. pinchy-files' vision API transcoding scanned PDFs). This
 *      path is pure Pinchy HTTP + DB with NO OpenClaw dependency, so it is
 *      verified here honestly against a real PostgreSQL — and runs in the
 *      ordinary `pnpm test:db` CI job (issue #426 case 3).
 *
 * This file deliberately hits the real `db` (no `@/db` mock) so the assertion
 * is "a row with the declared token counts actually lands in usage_records",
 * not "insert() was called".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { classifyUsageSource } from "@/lib/usage-source";
import { POST } from "@/app/api/internal/usage/record/route";

const GATEWAY_TOKEN = "integration-gateway-token";

function recordRequest(body: Record<string, unknown>, token = GATEWAY_TOKEN) {
  return new NextRequest("http://localhost/api/internal/usage/record", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe("usage tracking — internal usage endpoint (plugin/vision path)", () => {
  const originalToken = process.env.PINCHY_E2E_GATEWAY_TOKEN;

  beforeEach(() => {
    // readGatewayToken() honors PINCHY_E2E_GATEWAY_TOKEN ahead of the on-disk
    // config, so the real validateGatewayToken passes without a mock.
    process.env.PINCHY_E2E_GATEWAY_TOKEN = GATEWAY_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.PINCHY_E2E_GATEWAY_TOKEN;
    else process.env.PINCHY_E2E_GATEWAY_TOKEN = originalToken;
  });

  it("captures tokens added by vision/plugin calls in usage_records", async () => {
    // A plugin reporting vision tokens uses a `plugin:<pluginId>` session key.
    const sessionKey = "plugin:pinchy-files";
    const res = await POST(
      recordRequest({
        agentId: "agent-vision-1",
        agentName: "Vision Agent",
        userId: "user-1",
        sessionKey,
        model: "qwen2.5-vision",
        inputTokens: 1234,
        outputTokens: 56,
      })
    );
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sessionKey, sessionKey));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: "agent-vision-1",
      agentName: "Vision Agent",
      userId: "user-1",
      sessionKey,
      model: "qwen2.5-vision",
      inputTokens: 1234,
      outputTokens: 56,
    });

    // The dashboard's source breakdown must bucket this row under "plugin"
    // (not "chat" or "system"). The summary route mirrors this classifier as
    // a SQL CASE expression; keep them in sync.
    expect(classifyUsageSource(rows[0].sessionKey)).toBe("plugin");
  });

  it("rejects an unauthenticated report and writes no row", async () => {
    const res = await POST(
      recordRequest(
        {
          agentId: "agent-x",
          agentName: "X",
          userId: "user-1",
          sessionKey: "plugin:pinchy-files",
          inputTokens: 10,
          outputTokens: 5,
        },
        "wrong-token"
      )
    );
    expect(res.status).toBe(401);

    const rows = await db.select().from(usageRecords);
    expect(rows).toHaveLength(0);
  });
});
