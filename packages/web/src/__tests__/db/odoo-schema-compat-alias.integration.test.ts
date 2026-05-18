/**
 * Integration test for the 0032_odoo_schema_compat_alias migration SQL.
 *
 * Migration 0031 split `odoo_schema` into `odoo_list_models` +
 * `odoo_describe_model` in agents' allowed_tools. But the pinchy-odoo plugin
 * re-introduces `odoo_schema` as a deprecated alias for backwards
 * compatibility with pre-v0.5.4 AGENTS.md files (which still tell the model
 * "always call odoo_schema first"). Without the alias being in allowed_tools,
 * permission checks reject the call before it reaches the plugin.
 *
 * Migration 0032 re-adds `odoo_schema` to every agent that received the
 * 0031 rename. It must be:
 *   1. Effective: agents with `odoo_describe_model` gain `odoo_schema`.
 *   2. Idempotent: agents that already have `odoo_schema` are unchanged.
 *   3. Conservative: agents with no odoo tooling are not touched.
 */

import { describe, it, expect, afterEach } from "vitest";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { sql, eq } from "drizzle-orm";

const AGENT_MIGRATED = "test-odoo-compat-1";
const AGENT_ALREADY_HAS_ALIAS = "test-odoo-compat-2";
const AGENT_NO_ODOO = "test-odoo-compat-3";

async function runMigration() {
  await db.execute(sql`
    UPDATE agents
    SET allowed_tools = allowed_tools || '["odoo_schema"]'::jsonb
    WHERE allowed_tools @> '["odoo_describe_model"]'::jsonb
      AND NOT (allowed_tools @> '["odoo_schema"]'::jsonb)
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

describe("0032 odoo_schema compat-alias migration", () => {
  afterEach(async () => {
    await db.delete(agents).where(eq(agents.id, AGENT_MIGRATED));
    await db.delete(agents).where(eq(agents.id, AGENT_ALREADY_HAS_ALIAS));
    await db.delete(agents).where(eq(agents.id, AGENT_NO_ODOO));
  });

  it("adds odoo_schema to agents that have odoo_describe_model", async () => {
    await insertTestAgent(AGENT_MIGRATED, ["odoo_list_models", "odoo_describe_model", "odoo_read"]);

    await runMigration();

    const tools = await getTools(AGENT_MIGRATED);
    expect(tools).toContain("odoo_schema");
    expect(tools).toContain("odoo_list_models");
    expect(tools).toContain("odoo_describe_model");
    expect(tools).toContain("odoo_read");
  });

  it("is idempotent — re-running adds no duplicates", async () => {
    await insertTestAgent(AGENT_ALREADY_HAS_ALIAS, [
      "odoo_list_models",
      "odoo_describe_model",
      "odoo_schema",
    ]);

    await runMigration();
    await runMigration();

    const tools = await getTools(AGENT_ALREADY_HAS_ALIAS);
    const schemaOccurrences = tools.filter((t) => t === "odoo_schema").length;
    expect(schemaOccurrences).toBe(1);
  });

  it("does not touch agents without odoo_describe_model", async () => {
    await insertTestAgent(AGENT_NO_ODOO, ["pinchy_ls", "pinchy_read"]);

    await runMigration();

    const tools = await getTools(AGENT_NO_ODOO);
    expect(tools).not.toContain("odoo_schema");
    expect(tools).toEqual(["pinchy_ls", "pinchy_read"]);
  });
});
