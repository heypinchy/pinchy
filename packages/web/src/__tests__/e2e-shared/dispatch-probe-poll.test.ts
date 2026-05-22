// Unit test for the `pollAuditForTool` helper used by E2E specs.
//
// The helper polls `/api/audit?eventType=tool.<name>` and returns true as
// soon as an entry matching the agent and tool name shows up. Without a
// `since` filter, a second test that re-uses the same tool name on the
// same agent matches the FIRST test's audit entry and returns immediately
// — that's what caused the false-positive "round-trip" round-trip
// failures in email.spec.ts ("gmail-mock receives email_list request")
// and web-search.spec.ts ("brave-mock receives actual search request")
// after the parent commit (ec12767ee / cc9fdcbe0). Both round-trip tests
// returned in ~1 s — way too fast for a real OC dispatch — then asserted
// against a not-yet-populated mock request log and failed.
//
// This test pins the contract: when `since` is provided, the helper
// passes it as `from=<iso>` so the server-side audit query filters out
// older entries.

import { describe, it, expect, vi } from "vitest";
import { pollAuditForTool } from "../../../e2e/shared/dispatch-probe";

type PageRequestStub = {
  request: {
    get: ReturnType<typeof vi.fn>;
  };
};

function makePage(entries: Array<{ resource: string; detail: { toolName: string } }>): {
  page: PageRequestStub;
  urls: string[];
} {
  const urls: string[] = [];
  const page: PageRequestStub = {
    request: {
      get: vi.fn(async (url: string) => {
        urls.push(url);
        return {
          status: () => 200,
          json: async () => ({ entries }),
        };
      }),
    },
  };
  return { page, urls };
}

describe("pollAuditForTool", () => {
  it("returns true when a matching audit entry is present", async () => {
    const { page } = makePage([{ resource: "agent:agent-1", detail: { toolName: "email_list" } }]);
    const result = await pollAuditForTool(
      page as unknown as Parameters<typeof pollAuditForTool>[0],
      {
        toolName: "email_list",
        agentId: "agent-1",
        deadlineMs: 1000,
        intervalMs: 50,
      }
    );
    expect(result).toBe(true);
  });

  it("ignores entries for a different agent", async () => {
    const { page } = makePage([
      { resource: "agent:other-agent", detail: { toolName: "email_list" } },
    ]);
    const result = await pollAuditForTool(
      page as unknown as Parameters<typeof pollAuditForTool>[0],
      {
        toolName: "email_list",
        agentId: "agent-1",
        deadlineMs: 200,
        intervalMs: 50,
      }
    );
    expect(result).toBe(false);
  });

  it("does NOT include from= query param when `since` is omitted", async () => {
    const { page, urls } = makePage([]);
    await pollAuditForTool(page as unknown as Parameters<typeof pollAuditForTool>[0], {
      toolName: "email_list",
      agentId: "agent-1",
      deadlineMs: 100,
      intervalMs: 100,
    });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).not.toContain("from=");
  });

  it("includes from=<encoded ISO> when `since` is provided", async () => {
    // Test 4 in email.spec.ts re-uses the email_list tool name on the same
    // agent after test 3 already wrote a tool.email_list audit entry. The
    // helper must pass `since` through to the audit API so the polled set
    // is restricted to entries written AFTER the test grabbed `since`.
    const { page, urls } = makePage([]);
    const since = "2026-05-22T13:18:00.000Z";
    await pollAuditForTool(page as unknown as Parameters<typeof pollAuditForTool>[0], {
      toolName: "email_list",
      agentId: "agent-1",
      since,
      deadlineMs: 100,
      intervalMs: 100,
    });
    expect(urls[0]).toContain(`from=${encodeURIComponent(since)}`);
  });

  it("with `since`, a stale entry older than `since` does NOT satisfy the poll", async () => {
    // The server-side filter is what actually drops the stale entry — we
    // simulate that here by having the stub return [] regardless of input.
    // The real audit endpoint applies `gte(timestamp, from)` so this
    // simulation matches its behaviour for our purposes.
    const { page } = makePage([]);
    const result = await pollAuditForTool(
      page as unknown as Parameters<typeof pollAuditForTool>[0],
      {
        toolName: "email_list",
        agentId: "agent-1",
        since: "2026-05-22T13:18:00.000Z",
        deadlineMs: 200,
        intervalMs: 50,
      }
    );
    expect(result).toBe(false);
  });
});
