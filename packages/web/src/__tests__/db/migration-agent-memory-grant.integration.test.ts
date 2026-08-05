/**
 * Integration test for the 0069_agent_memory_grant migration SQL.
 *
 * Memory became its own permission instead of a side effect of `pinchy_write`
 * (plans/2026-08-05-agent-permissions-by-zone-design.md). This migration is
 * what stops that split from being a silent revocation, and what repairs the
 * agents that never had memory in the first place.
 *
 * The three rules:
 *   1. An agent with `pinchy_write` keeps its memory. Not optional — it may
 *      already have written to MEMORY.md / memory/.
 *   2. An agent from a curated template gains memory (templates are generous).
 *   3. A personal agent gains memory (Smithers has no template_id).
 * …and `custom` agents gain nothing, because "start from scratch" means it.
 *
 * Runs via `pnpm -C packages/web test:db` against the dev-stack Postgres on
 * :5434 (or VITEST_INTEGRATION_DB_URL in CI). The global setup creates a fresh
 * migrated DB, so the migration is re-executed here as plain UPDATE statements
 * rather than through drizzle-kit, which would be a no-op on an already-migrated
 * DB.
 *
 * It re-executes the SHIPPED FILE, not a copy of it. A copy would be a
 * hand-maintained mirror of code — the failure mode AGENTS.md keeps naming: edit
 * the .sql, and a test that re-types the statements stays green about a
 * migration it no longer describes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { sql, eq } from "drizzle-orm";

const MIGRATION_FILE = join(process.cwd(), "drizzle", "0069_agent_memory_grant.sql");

const WRITER = "test-mem-grant-writer";
const TEMPLATED = "test-mem-grant-templated";
const CUSTOM = "test-mem-grant-custom";
const PERSONAL = "test-mem-grant-personal";
const ALREADY = "test-mem-grant-already";
const NO_TEMPLATE = "test-mem-grant-no-template";

const ALL_IDS = [WRITER, TEMPLATED, CUSTOM, PERSONAL, ALREADY, NO_TEMPLATE];

/**
 * The statements of 0069, read off disk.
 *
 * Split rather than executed in one call: drizzle sends `db.execute` through a
 * prepared statement, and Postgres' extended protocol accepts exactly one
 * command per message. Comment lines go first so a `--` line can never hide the
 * `;` that ends the statement it sits above.
 */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION_FILE, "utf-8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function runMigration() {
  for (const statement of migrationStatements()) {
    await db.execute(sql.raw(statement));
  }
}

async function insertTestAgent(
  id: string,
  tools: string[],
  extra: { templateId?: string | null; isPersonal?: boolean } = {}
) {
  const values = {
    id,
    name: `Test Agent ${id}`,
    model: "anthropic/claude-sonnet-4-6",
    greetingMessage: "Hi, how can I help?",
    allowedTools: tools,
    templateId: extra.templateId ?? null,
    isPersonal: extra.isPersonal ?? false,
  };
  await db.insert(agents).values(values).onConflictDoUpdate({ target: agents.id, set: values });
}

async function getTools(id: string): Promise<string[]> {
  const [row] = await db
    .select({ tools: agents.allowedTools })
    .from(agents)
    .where(eq(agents.id, id));
  return (row?.tools ?? []) as string[];
}

describe("0069 agent memory grant migration", () => {
  afterEach(async () => {
    for (const id of ALL_IDS) {
      await db.delete(agents).where(eq(agents.id, id));
    }
  });

  it("reads all three rules out of the migration file", () => {
    // The two "grants nothing" tests below pass vacuously if the split returns
    // an empty list, so the corpus is asserted rather than assumed. The
    // positive tests would still fail loudly — this one names the cause.
    const statements = migrationStatements();
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement).toMatch(/^UPDATE agents/);
    }
  });

  it("keeps memory for an agent that has it today via pinchy_write", async () => {
    // The load-bearing rule. This agent's memory paths came from pinchy_write,
    // so it may already have files under memory/. Splitting the grants without
    // this would make its own writes unreachable.
    await insertTestAgent(WRITER, ["pinchy_write", "email_read"]);

    await runMigration();

    const tools = await getTools(WRITER);
    expect(tools).toContain("pinchy_memory");
    expect(tools).toContain("pinchy_write");
    expect(tools).toContain("email_read");
  });

  it("grants memory to an agent created from a curated template", async () => {
    // The reported case: no template ever granted pinchy_write, so a
    // template-created agent had memory_search/memory_get and nothing to
    // search (#755).
    await insertTestAgent(TEMPLATED, ["knowledge_search"], {
      templateId: "knowledge-base",
    });

    await runMigration();

    expect(await getTools(TEMPLATED)).toContain("pinchy_memory");
  });

  it("grants nothing to an agent created from the from-scratch template", async () => {
    await insertTestAgent(CUSTOM, [], { templateId: "custom" });

    await runMigration();

    expect(await getTools(CUSTOM)).toEqual([]);
  });

  it("grants memory to a personal agent, which carries no template_id", async () => {
    // Smithers is created by createSmithersAgent, not from a template, so rule
    // 2 cannot see it — and it is the case where memory is least controversial.
    await insertTestAgent(PERSONAL, ["pinchy_save_user_context"], {
      isPersonal: true,
    });

    await runMigration();

    expect(await getTools(PERSONAL)).toContain("pinchy_memory");
  });

  it("leaves a template-less, non-personal agent alone", async () => {
    // An agent created through the API with neither a template nor a write
    // grant made no decision about memory. Nothing here should invent one.
    await insertTestAgent(NO_TEMPLATE, ["email_read"]);

    await runMigration();

    expect(await getTools(NO_TEMPLATE)).toEqual(["email_read"]);
  });

  it("is idempotent — a second run adds no duplicate", async () => {
    await insertTestAgent(ALREADY, ["pinchy_write", "pinchy_memory"]);

    await runMigration();
    await runMigration();

    const tools = await getTools(ALREADY);
    expect(tools.filter((t) => t === "pinchy_memory")).toHaveLength(1);
  });

  it("adds no duplicate when two rules match the same agent", async () => {
    // A personal agent that also holds pinchy_write matches rules 1 and 3. The
    // `NOT (@> ...)` guard on every rule is what keeps the array a set; without
    // it the jsonb || append would happily store the value twice.
    await insertTestAgent(PERSONAL, ["pinchy_write"], { isPersonal: true });

    await runMigration();

    const tools = await getTools(PERSONAL);
    expect(tools.filter((t) => t === "pinchy_memory")).toHaveLength(1);
  });
});
