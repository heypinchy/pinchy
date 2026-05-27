import { execSync } from "node:child_process";

// Re-using the same docker-compose stack invocation across overlays. Encoded
// as a constant so the test author doesn't accidentally drift between calls.
const COMPOSE_ARGS = [
  "-f docker-compose.yml",
  "-f docker-compose.e2e.yml",
  "-f docker-compose.setup-wizard-test.yml",
].join(" ");

/**
 * Reset the test stack between specs so each test starts with a fresh
 * "setup wizard not yet completed" state. Truncates Pinchy's app tables
 * (DB stays mounted — pgdata is preserved) and restarts pinchy + openclaw
 * so the new admin account, settings, and agents are recreated cleanly.
 *
 * Volumes are NOT removed. Project memory: never run `docker compose down -v`,
 * even in tests — pgdata is the production DB volume in non-test stacks and
 * the safety habit is more valuable than the marginal cleanup.
 *
 * Table names verified against packages/web/src/db/schema.ts:
 *   users      → pgTable("user")
 *   accounts   → pgTable("account")
 *   agents     → pgTable("agents")
 *   settings   → pgTable("settings")
 *   auditLog   → pgTable("audit_log")   (NOT "audit_events")
 */
export function resetStack(): void {
  execSync(
    `docker compose ${COMPOSE_ARGS} exec -T db ` +
      `psql -U pinchy -d pinchy -c ` +
      `'TRUNCATE TABLE "user", account, agents, settings, audit_log RESTART IDENTITY CASCADE'`,
    { stdio: "pipe" }
  );
  execSync(`docker compose ${COMPOSE_ARGS} restart pinchy openclaw`, { stdio: "pipe" });

  // Poll /api/setup/status until Pinchy answers — this proves the regenerated
  // openclaw.json has been picked up and the wizard route is reachable.
  // 60 s budget: container restart + Next.js cold compile can run ~30 s.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      execSync(`curl -fsS http://localhost:7777/api/setup/status`, { stdio: "pipe" });
      return;
    } catch {
      // server still warming up
    }
    execSync("sleep 1", { stdio: "pipe" });
  }
  throw new Error("Pinchy did not become ready within 60s after reset");
}
