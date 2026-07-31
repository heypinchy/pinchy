/**
 * Who may fetch a connection's decrypted credentials (#987).
 *
 * `GET /api/internal/integrations/:connectionId/credentials` authorized on
 * possession of the gateway token alone. That token is a SINGLE shared secret
 * inlined into every plugin's config block by `openclaw-config/build.ts`, so
 * any code running in the OpenClaw container could ask for any connection's
 * decrypted Odoo password or mailbox token — including connections belonging
 * to an agent it has nothing to do with.
 *
 * The decision below is the missing cross-check, kept as a pure function so
 * every branch is testable without a database. The loader that feeds it is
 * covered separately against real Postgres
 * (`authorize-agent-connection.integration.test.ts`), because the thing that
 * actually goes wrong in a rule like this is the QUERY — a join that matches
 * more rows than intended — not the `if`.
 *
 * Two grant models exist and both had to be honored; treating either as the
 * general case breaks a live feature:
 *
 *   - Odoo / email connections are granted per agent through
 *     `agent_connection_permissions` (rows per model+operation). A grant is
 *     "at least one row for this (agent, connection)".
 *   - The web-search connection is instance-wide: `build.ts` hands the SAME
 *     `webConn.id` to every agent and gates access on the agent's
 *     `allowedTools` instead. It has no permission rows at all, so requiring
 *     one would have revoked web search from every agent in the instance.
 */

import { describe, expect, it } from "vitest";

import {
  decideConnectionAccess,
  type AgentForAuth,
  type ConnectionForAuth,
} from "@/lib/integrations/authorize-agent-connection";

const ODOO_CONN: ConnectionForAuth = { id: "conn-odoo", type: "odoo", name: "Odoo Production" };
const WEB_CONN: ConnectionForAuth = { id: "conn-web", type: "web-search", name: "Brave Search" };

const AGENT: AgentForAuth = { id: "agent-1", name: "Bookkeeper", allowedTools: ["odoo_read"] };

describe("decideConnectionAccess", () => {
  describe("per-agent granted connections (odoo, email)", () => {
    it("allows an agent that holds at least one permission row", () => {
      expect(decideConnectionAccess(AGENT, ODOO_CONN, 1)).toEqual({ allowed: true });
    });

    it("denies an agent that holds none — the #987 case", () => {
      // Agent B asking for agent A's Odoo connection. Both are real, the
      // gateway token is valid, and before this check the answer was a 200
      // carrying a decrypted password.
      expect(decideConnectionAccess(AGENT, ODOO_CONN, 0)).toEqual({
        allowed: false,
        reason: "not-granted",
      });
    });

    it.each(["google", "microsoft", "imap"] as const)(
      "applies the same rule to %s mailbox connections",
      (type) => {
        const conn: ConnectionForAuth = { id: "conn-mail", type, name: "Mailbox" };

        expect(decideConnectionAccess(AGENT, conn, 0)).toEqual({
          allowed: false,
          reason: "not-granted",
        });
        expect(decideConnectionAccess(AGENT, conn, 3)).toEqual({ allowed: true });
      }
    );
  });

  describe("the instance-wide web-search connection", () => {
    it.each(["pinchy_web_search", "pinchy_web_fetch"])(
      "allows an agent granted %s, despite zero permission rows",
      (tool) => {
        const agent: AgentForAuth = { ...AGENT, allowedTools: [tool] };

        expect(decideConnectionAccess(agent, WEB_CONN, 0)).toEqual({ allowed: true });
      }
    );

    it("denies an agent that has neither web tool", () => {
      expect(decideConnectionAccess(AGENT, WEB_CONN, 0)).toEqual({
        allowed: false,
        reason: "not-granted",
      });
    });

    it("does not let a stray permission row substitute for the tool grant", () => {
      // The web connection is never granted through the permissions table, so
      // a row pointing at it is either leftover or planted. It must not open
      // the Brave key to an agent whose tool list says otherwise.
      expect(decideConnectionAccess(AGENT, WEB_CONN, 5)).toEqual({
        allowed: false,
        reason: "not-granted",
      });
    });
  });

  describe("unknown subjects", () => {
    it("reports an unknown connection distinctly, so the route can keep its 404", () => {
      // Deliberately NOT "not-granted": the route answers a missing connection
      // with an actionable "no longer connected" 404 that an admin can act on,
      // and turning that into a 403 would send users hunting for a permission
      // problem that does not exist.
      expect(decideConnectionAccess(AGENT, null, 0)).toEqual({
        allowed: false,
        reason: "connection-unknown",
      });
    });

    it("reports connection-unknown even when the agent is unknown too, so the 404 survives a stale agent id", () => {
      // Note what this does NOT claim. Checking the connection first does not
      // hide connection existence — 404-vs-403 answers that without a valid
      // agent id, and `decideConnectionAccess` says why that is accepted. What
      // the order buys is the admin-facing case: an integration that was
      // removed took its grants with it, so the agent id in the plugin's call
      // is stale too, and the answer still has to be the actionable 404.
      expect(decideConnectionAccess(null, null, 0)).toEqual({
        allowed: false,
        reason: "connection-unknown",
      });
    });

    it("denies an agent that does not exist (or was soft-deleted)", () => {
      expect(decideConnectionAccess(null, ODOO_CONN, 7)).toEqual({
        allowed: false,
        reason: "agent-unknown",
      });
    });
  });

  it("denies a negative or non-integer grant count rather than trusting it", () => {
    // `grantCount` comes from a COUNT(*) that could in principle arrive as a
    // string or NaN through the driver. `> 0` is false for NaN, which is the
    // safe direction, and this pins that it stays the safe direction.
    expect(decideConnectionAccess(AGENT, ODOO_CONN, Number.NaN)).toEqual({
      allowed: false,
      reason: "not-granted",
    });
    expect(decideConnectionAccess(AGENT, ODOO_CONN, -1)).toEqual({
      allowed: false,
      reason: "not-granted",
    });
  });
});
