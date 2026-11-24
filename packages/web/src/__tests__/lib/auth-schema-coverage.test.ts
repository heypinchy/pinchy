import { describe, it, expect } from "vitest";
import { getAuthTables } from "@better-auth/core/db";
import { getTableColumns, type Table } from "drizzle-orm";
import { auth } from "@/lib/auth";
import * as schema from "@/db/schema";

// Pinchy maintains every Better Auth table by hand in Drizzle (db/schema.ts),
// so nothing ties it to what the configured plugins declare. better-auth >= 1.7
// checks that at first use and throws "Drizzle schema mismatch" on the first
// request when a declared field has no column — which the 1.6 -> 1.7 bump hit
// for the admin plugin's `session.impersonatedBy`, in the integration suite
// only. This is the same check without a database, so the next plugin option
// or dependency bump that adds a field fails here, by name, in `pnpm test`.
//
// The model -> table mapping mirrors the explicit adapter mapping in lib/auth.ts.
const DRIZZLE_TABLE_BY_MODEL: Record<string, Table> = {
  user: schema.users,
  session: schema.sessions,
  account: schema.accounts,
  apikey: schema.apiKeys,
  verification: schema.verification,
};

describe("Better Auth tables vs the hand-written Drizzle schema", () => {
  const authTables = getAuthTables(auth.options);

  it("finds the tables of the configured plugins (not an empty walk)", () => {
    expect(Object.keys(authTables)).toEqual(
      expect.arrayContaining(["user", "session", "account", "verification", "apikey"])
    );
  });

  for (const [model, authTable] of Object.entries(authTables)) {
    it(`${model}: every field Better Auth declares has a Drizzle column`, () => {
      const table = DRIZZLE_TABLE_BY_MODEL[model];
      expect(table, `no Drizzle table mapped for Better Auth model "${model}"`).toBeDefined();

      const columnKeys = Object.keys(getTableColumns(table));
      const missing = Object.keys(authTable.fields).filter((field) => !columnKeys.includes(field));
      expect(missing).toEqual([]);
    });
  }
});
