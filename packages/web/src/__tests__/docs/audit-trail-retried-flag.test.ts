import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const repoRoot = resolve(__dirname, "../../../../..");
const auditTrailPath = resolve(repoRoot, "docs/src/content/docs/concepts/audit-trail.mdx");
const auditTrail = readFileSync(auditTrailPath, "utf-8");

describe("audit-trail.mdx documents chat.agent_error.retried flag (#310 Tier 2 docs gap, #355 signal)", () => {
  it("chat.agent_error table row mentions `retried` so operators can filter dispatch-race retries", () => {
    // PR #442 (Tier 2a of #310) added a server-side single-shot retry for the
    // OpenClaw 2026.5.x dispatch-race "unknown agent id" error in
    // `packages/web/src/server/chat-dispatch-retry.ts`. When the retry succeeds
    // silently, Pinchy still writes the `chat.agent_error` umbrella audit row
    // but tags `detail.retried: true` (see `writeAgentErrorAudit` in
    // `client-router.ts`) so operator dashboards can distinguish self-healing
    // transients from user-visible failures — the measurement signal called
    // out in #355.
    //
    // The flag landed in code but the audit-trail docs table only lists
    // `errorClass` and `providerError` as detail fields. This guard pins the
    // docs to mention `retried` so the field is discoverable when operators
    // craft SQL queries for the v0.6.0 release.
    const lines = auditTrail.split(/\r?\n/);
    const row = lines.find((l) => /^\|\s*`chat\.agent_error`/.test(l));
    expect(row, "chat.agent_error table row not found in audit-trail.mdx").toBeDefined();
    // Match `retried` as a backticked identifier OR a backticked field assignment
    // (`retried: true`) — both shapes communicate the same operator-facing fact.
    expect(row!).toMatch(/`retried\b/);
  });
});
