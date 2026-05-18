/**
 * Integration test for the 0031_odoo_schema_rename migration SQL.
 *
 * Verifies that the migration:
 *   1. Replaces `odoo_schema` with `odoo_list_models` + `odoo_describe_model`
 *      while preserving other tools in the array.
 *   2. Is idempotent: running against an already-migrated row changes nothing.
 *   3. Handles the partial-overlap case: an agent that already has
 *      `odoo_describe_model` but still has `odoo_schema` only has the legacy
 *      entry removed, without duplicating the new tools.
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

// Stable IDs for test agents; afterEach cleans them up.
const AGENT_ONLY_OLD = "test-odoo-rename-1";
const AGENT_ALREADY_MIGRATED = "test-odoo-rename-2";
const AGENT_PARTIAL_OVERLAP = "test-odoo-rename-3";

// The migration SQL split into its two UPDATE passes so each can be run
// programmatically through drizzle's `db.execute`.
async function runMigration() {
  // Pass 1: replace odoo_schema → list_models + describe_model where not yet done
  await db.execute(sql`
    UPDATE agents
    SET allowed_tools = (allowed_tools - 'odoo_schema')
      || '["odoo_list_models", "odoo_describe_model"]'::jsonb
    WHERE allowed_tools @> '["odoo_schema"]'::jsonb
      AND NOT (allowed_tools @> '["odoo_describe_model"]'::jsonb)
  `);

  // Pass 2: drop any remaining odoo_schema entries (partial-overlap case)
  await db.execute(sql`
    UPDATE agents
    SET allowed_tools = allowed_tools - 'odoo_schema'
    WHERE allowed_tools @> '["odoo_schema"]'::jsonb
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

describe("0031 odoo_schema rename migration", () => {
  afterEach(async () => {
    await db.delete(agents).where(eq(agents.id, AGENT_ONLY_OLD));
    await db.delete(agents).where(eq(agents.id, AGENT_ALREADY_MIGRATED));
    await db.delete(agents).where(eq(agents.id, AGENT_PARTIAL_OVERLAP));
  });

  it("replaces odoo_schema with odoo_list_models + odoo_describe_model, preserving other tools", async () => {
    await insertTestAgent(AGENT_ONLY_OLD, ["odoo_schema", "odoo_read", "odoo_write"]);

    await runMigration();

    const tools = await getTools(AGENT_ONLY_OLD);
    expect(tools).toContain("odoo_list_models");
    expect(tools).toContain("odoo_describe_model");
    expect(tools).toContain("odoo_read");
    expect(tools).toContain("odoo_write");
    expect(tools).not.toContain("odoo_schema");
  });

  it("is idempotent: re-running on an already-migrated agent changes nothing", async () => {
    await insertTestAgent(AGENT_ALREADY_MIGRATED, [
      "odoo_list_models",
      "odoo_describe_model",
      "odoo_read",
    ]);

    await runMigration();

    const tools = await getTools(AGENT_ALREADY_MIGRATED);
    expect(tools).toContain("odoo_list_models");
    expect(tools).toContain("odoo_describe_model");
    expect(tools).toContain("odoo_read");
    expect(tools).not.toContain("odoo_schema");
    // Ensure no duplicates were inserted
    expect(tools.filter((t) => t === "odoo_list_models")).toHaveLength(1);
    expect(tools.filter((t) => t === "odoo_describe_model")).toHaveLength(1);
  });

  it("handles partial overlap: removes odoo_schema without re-adding new tools if already present", async () => {
    // Simulate an agent edited by a UI that already added the new names but
    // left the legacy entry in place.
    await insertTestAgent(AGENT_PARTIAL_OVERLAP, [
      "odoo_schema",
      "odoo_list_models",
      "odoo_describe_model",
      "odoo_read",
    ]);

    await runMigration();

    const tools = await getTools(AGENT_PARTIAL_OVERLAP);
    expect(tools).toContain("odoo_list_models");
    expect(tools).toContain("odoo_describe_model");
    expect(tools).toContain("odoo_read");
    expect(tools).not.toContain("odoo_schema");
    // No duplicates from the second pass
    expect(tools.filter((t) => t === "odoo_list_models")).toHaveLength(1);
    expect(tools.filter((t) => t === "odoo_describe_model")).toHaveLength(1);
  });
});
