import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { processedEmails } from "@/db/schema";

const cols = (t: unknown) => (t as any)[Symbol.for("drizzle:Columns")];

describe("processed_emails schema", () => {
  it("has the expected columns", () => {
    expect(Object.keys(cols(processedEmails))).toEqual(
      expect.arrayContaining([
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
    const c = cols(processedEmails);
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
    expect(claim!.config.columns.map((col: { name: string }) => col.name)).toEqual([
      "workflow_id",
      "connection_id",
      "provider_message_id",
    ]);
  });
});
