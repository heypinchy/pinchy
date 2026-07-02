import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * oauth-providers.ts is imported by Client Components (the Connected apps
 * section, the connect-step wizard, the edit-OAuth dialog). If it pulls in the
 * server-only settings/db layer — directly or by importing oauth-settings.ts,
 * which imports `@/lib/settings` → `db` → `postgres` — then postgres lands in
 * the client bundle and `next build` fails with "module not found".
 *
 * That boundary is invisible to `tsc` (it type-checks, no bundling) and to the
 * Node-based vitest suite (postgres resolves fine in Node), so only the real
 * build catches it. This guard pins the direct-import surface so a regression
 * fails here in milliseconds instead of only in the Docker build.
 */
describe("oauth-providers stays client-safe", () => {
  const src = readFileSync(
    resolve(__dirname, "../../../lib/integrations/oauth-providers.ts"),
    "utf8"
  );

  it("does not import the server-only settings/db layer", () => {
    expect(src).not.toContain('from "@/lib/settings"');
    expect(src).not.toContain('from "@/db"');
    // The dependency must point the other way: oauth-settings.ts (server-only)
    // re-exports the settings keys FROM this module, not vice versa.
    expect(src).not.toContain('from "@/lib/integrations/oauth-settings"');
  });
});
