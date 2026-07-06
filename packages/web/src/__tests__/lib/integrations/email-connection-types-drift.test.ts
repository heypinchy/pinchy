// packages/web/src/__tests__/lib/integrations/email-connection-types-drift.test.ts
//
// Drift guard: these call sites (the templates-availability route, the
// agent-settings email permission section, the OpenClaw config builder, and
// the integrations settings page's app-configured lookup) used to each
// declare their own local list/Set of "which
// integration_connections.type values count as email" — and had drifted
// (["google","microsoft"] vs ["google","microsoft","imap"]). They must now
// all import EMAIL_CONNECTION_TYPES from
// `@/lib/integrations/oauth-providers.ts` instead of re-declaring the list.
//
// This test does source inspection (not type-checking) because a shared
// import can't diverge in value by construction — the risk this guards
// against is a NEW local re-declaration creeping back in, e.g. someone
// "fixing a bug" by hardcoding `["google", "microsoft", "imap"]` again
// directly in one of the call sites instead of updating the shared constant.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CALL_SITES = [
  "../../../app/api/templates/route.ts",
  "../../../components/agent-settings-permissions.tsx",
  "../../../lib/openclaw-config/build.ts",
  "../../../components/settings-integrations.tsx",
] as const;

// Matches a local `const X = [...]` array or `new Set([...])` literal whose
// contents look like the email-connection-type list this constant replaced,
// e.g. `["google", "microsoft"]` or `["google", "microsoft", "imap"]` in
// either quote style and in any order-preserving arrangement of those two.
const LOCAL_REDECLARATION_PATTERN =
  /=\s*(?:new Set\()?\[\s*["']google["']\s*,\s*["']microsoft["'](?:\s*,\s*["']imap["'])?\s*\]/;

describe("email connection types stay single-sourced", () => {
  for (const relativePath of CALL_SITES) {
    it(`${relativePath} imports EMAIL_CONNECTION_TYPES instead of re-declaring it`, () => {
      const src = readFileSync(resolve(__dirname, relativePath), "utf8");

      expect(src).toContain(
        'import { EMAIL_CONNECTION_TYPES } from "@/lib/integrations/oauth-providers"'
      );
      expect(LOCAL_REDECLARATION_PATTERN.test(src)).toBe(false);
    });
  }

  it("the shared module exports EMAIL_CONNECTION_TYPES including 'imap'", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../lib/integrations/oauth-providers.ts"),
      "utf8"
    );

    expect(src).toMatch(/export const EMAIL_CONNECTION_TYPES\s*=\s*\[/);
    // "imap" is real now: packages/plugins/pinchy-email/imap-adapter.ts
    // implements the full EmailAdapter contract and the internal credentials
    // route dispatches on type === "imap". Every "is this connection type
    // email-capable" consumer must recognize it, even though the connection
    // *creation* route doesn't accept type: "imap" yet.
    expect(src).toMatch(
      /EMAIL_CONNECTION_TYPES\s*=\s*\[\s*["']google["']\s*,\s*["']microsoft["']\s*,\s*["']imap["']/
    );
  });
});
