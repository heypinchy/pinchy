import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { agents, agentConnectionPermissions, settings } from "@/db/schema";
import { softDeleteAgentRows } from "@/lib/agent-soft-delete";

// A recording stand-in for a drizzle transaction: every update/delete keeps
// the table it targeted and the WHERE it was given, so the test can read the
// SQL that would run.
function recordingTx() {
  const calls: Array<{ op: "update" | "delete"; table: unknown; where?: SQL; set?: unknown }> = [];
  const tx = {
    update: vi.fn((table: unknown) => {
      const call: (typeof calls)[number] = { op: "update", table };
      calls.push(call);
      return {
        set: (values: unknown) => {
          call.set = values;
          return {
            where: (where: SQL) => {
              call.where = where;
              return { returning: vi.fn().mockResolvedValue([{ id: "agent-1" }]) };
            },
          };
        },
      };
    }),
    delete: vi.fn((table: unknown) => {
      const call: (typeof calls)[number] = { op: "delete", table };
      calls.push(call);
      return {
        where: (where: SQL) => {
          call.where = where;
          return Promise.resolve();
        },
      };
    }),
  };
  return { tx, calls };
}

const dialect = new PgDialect();
const paramsOf = (where?: SQL) => (where ? dialect.sqlToQuery(where).params : []);

describe("softDeleteAgentRows", () => {
  it("marks the agents deleted and removes their grants and per-agent Telegram settings", async () => {
    const { tx, calls } = recordingTx();
    const rows = await softDeleteAgentRows(tx as never, ["agent-1", "agent-2"]);

    expect(rows).toEqual([{ id: "agent-1" }]);

    const update = calls.find((c) => c.op === "update" && c.table === agents);
    expect(update?.set).toEqual(expect.objectContaining({ deletedAt: expect.any(Date) }));
    expect(paramsOf(update?.where)).toEqual(["agent-1", "agent-2"]);

    const grants = calls.find((c) => c.op === "delete" && c.table === agentConnectionPermissions);
    expect(paramsOf(grants?.where)).toEqual(["agent-1", "agent-2"]);

    const telegram = calls.find((c) => c.op === "delete" && c.table === settings);
    expect(paramsOf(telegram?.where)).toEqual(
      expect.arrayContaining([
        "telegram_bot_token:agent-1",
        "telegram_bot_username:agent-1",
        "telegram_conflict_disabled:agent-1",
        "telegram_bot_token:agent-2",
        "telegram_bot_username:agent-2",
        "telegram_conflict_disabled:agent-2",
      ])
    );
  });

  it("touches nothing for an empty list", async () => {
    const { tx, calls } = recordingTx();
    await expect(softDeleteAgentRows(tx as never, [])).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });
});
