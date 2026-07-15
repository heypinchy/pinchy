import { describe, it, expect } from "vitest";
import { getTableColumns, type SQL } from "drizzle-orm";
import { getTableConfig, type IndexedColumn } from "drizzle-orm/pg-core";
import { processedEmails } from "@/db/schema";

/**
 * `IndexConfig.columns` is `Partial<IndexedColumn | SQL>[]` — an index can
 * mix plain columns and raw SQL expressions, so drizzle's own type only
 * guarantees the properties common to both (effectively none). Every column
 * in this unique index is a plain column reference, never a raw SQL
 * expression, so this narrows to that real case instead of asserting `name`
 * exists via a cast.
 */
function indexedColumnName(col: Partial<IndexedColumn | SQL>): string {
  if (!("name" in col) || typeof col.name !== "string") {
    throw new Error("expected a plain IndexedColumn with a string name, not a raw SQL expression");
  }
  return col.name;
}

describe("processed_emails schema", () => {
  it("has exactly the expected columns", () => {
    expect(new Set(Object.keys(getTableColumns(processedEmails)))).toEqual(
      new Set([
        "id",
        "workflowId",
        "connectionId",
        "providerMessageId",
        "messageIdHeader",
        "status",
        "outcome",
        "runId",
        "claimedAt",
        "finalizedAt",
      ])
    );
  });

  it("defaults status=processing and requires the claim-key columns", () => {
    const c = getTableColumns(processedEmails);
    expect(c.status.default).toBe("processing");
    expect(c.workflowId.notNull).toBe(true);
    expect(c.connectionId.notNull).toBe(true);
    expect(c.providerMessageId.notNull).toBe(true);
  });

  it("has the atomic-claim unique index on (workflowId, connectionId, providerMessageId)", () => {
    const { indexes } = getTableConfig(processedEmails);
    const claim = indexes.find((i) => i.config.name === "processed_emails_claim_uniq");
    expect(claim).toBeDefined();
    expect(claim!.config.unique).toBe(true);
    expect(claim!.config.columns.map(indexedColumnName)).toEqual([
      "workflow_id",
      "connection_id",
      "provider_message_id",
    ]);
  });
});
