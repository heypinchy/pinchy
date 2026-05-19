/**
 * Integration test for the 0033_remove_implicit_filesystem_tools migration SQL.
 *
 * Verifies that the migration:
 *   1. Removes `pinchy_ls` and `pinchy_read` from allowed_tools while
 *      preserving all other tools in the array.
 *   2. Is idempotent: running against an already-migrated row changes nothing.
 *   3. Does not touch agents that never had the implicit FS tools.
 *
 * Runs via `pnpm -C packages/web test:db` against the dev-stack Postgres on
 * :5434 (or VITEST_INTEGRATION_DB_URL in CI). The global-setup creates a
 * fresh migrated DB, so the migration SQL here is exercised as plain UPDATE
 * statements rather than through drizzle-kit (which would be a no-op on an
 * already-migrated DB).
 */

import { describe, it, expect, afterEach } from "vitest";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { sql, eq } from "drizzle-orm";

const AGENT_HAS_BOTH = "test-implicit-fs-1";
const AGENT_ALREADY_CLEAN = "test-implicit-fs-2";
const AGENT_UNTOUCHED = "test-implicit-fs-3";
const AGENT_ONLY_LS = "test-implicit-fs-4";

async function runMigration() {
  await db.execute(sql`
    UPDATE agents
    SET allowed_tools = (
      SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
      FROM jsonb_array_elements_text(allowed_tools::jsonb) AS t
      WHERE t NOT IN ('pinchy_ls', 'pinchy_read')
    )
    WHERE allowed_tools::jsonb @> '["pinchy_ls"]'::jsonb
       OR allowed_tools::jsonb @> '["pinchy_read"]'::jsonb
  `);
}

async function insertTestAgent(id: string, tools: string[]) {
  await db
    .insert(agents)
    .values({
      id,
      name: `Test Agent ${id}`,
      model: "anthropic/claude-sonnet-4-6",
      greetingMessage: "Hi, how can I help?",
      allowedTools: tools,
    })
    .onConflictDoUpdate({
      target: agents.id,
      set: { allowedTools: tools },
    });
}

async function getTools(id: string): Promise<string[]> {
  const [row] = await db
    .select({ tools: agents.allowedTools })
    .from(agents)
    .where(eq(agents.id, id));
  return (row?.tools ?? []) as string[];
}

describe("0033 remove implicit filesystem tools migration", () => {
  afterEach(async () => {
    await db.delete(agents).where(eq(agents.id, AGENT_HAS_BOTH));
    await db.delete(agents).where(eq(agents.id, AGENT_ALREADY_CLEAN));
    await db.delete(agents).where(eq(agents.id, AGENT_UNTOUCHED));
    await db.delete(agents).where(eq(agents.id, AGENT_ONLY_LS));
  });

  it("removes pinchy_ls and pinchy_read while preserving other tools", async () => {
    await insertTestAgent(AGENT_HAS_BOTH, [
      "pinchy_ls",
      "pinchy_read",
      "pinchy_write",
      "email_read",
    ]);

    await runMigration();

    const tools = await getTools(AGENT_HAS_BOTH);
    expect(tools).not.toContain("pinchy_ls");
    expect(tools).not.toContain("pinchy_read");
    expect(tools).toContain("pinchy_write");
    expect(tools).toContain("email_read");
    expect(tools).toHaveLength(2);
  });

  it("is idempotent: re-running on an already-clean agent changes nothing", async () => {
    await insertTestAgent(AGENT_ALREADY_CLEAN, ["pinchy_write", "email_read"]);

    await runMigration();

    const tools = await getTools(AGENT_ALREADY_CLEAN);
    expect(tools).toContain("pinchy_write");
    expect(tools).toContain("email_read");
    expect(tools).toHaveLength(2);
  });

  it("does not touch agents without the implicit FS tools", async () => {
    await insertTestAgent(AGENT_UNTOUCHED, ["odoo_read", "odoo_write", "email_send"]);

    await runMigration();

    const tools = await getTools(AGENT_UNTOUCHED);
    expect(tools).toEqual(["odoo_read", "odoo_write", "email_send"]);
  });

  it("removes only pinchy_ls when only pinchy_ls is present", async () => {
    await insertTestAgent(AGENT_ONLY_LS, ["pinchy_ls", "pinchy_write"]);

    await runMigration();

    const tools = await getTools(AGENT_ONLY_LS);
    expect(tools).not.toContain("pinchy_ls");
    expect(tools).toContain("pinchy_write");
    expect(tools).toHaveLength(1);
  });
});
