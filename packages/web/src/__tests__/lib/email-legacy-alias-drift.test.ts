// Cross-package drift guard (AGENTS.md § C10 — legacy email operation
// vocabulary): the "search"/"list" → "read" alias rule is implemented TWICE,
// once in the web package (tool-registry.ts's getEmailToolsForOperations,
// which drives what allowed_tools the config generator emits) and once in
// the pinchy-email plugin (permissions.ts's checkPermission, which gates
// tool calls at runtime). The two copies are linked only by comments — the
// plugin cannot import web code (it ships and runs standalone inside the
// OpenClaw container), so there is no way to share a single implementation.
//
// If a future change widens or narrows the alias in only ONE of the two
// places (e.g. someone adds a THIRD legacy operation to tool-registry.ts but
// forgets permissions.ts, or vice versa), the web-emitted allowed_tools and
// the plugin's runtime gate silently diverge: an agent could have a tool
// listed in `tools.allow` that the plugin then denies at the permission
// check (or the reverse — a plugin permission grant with no corresponding
// tool ever exposed). This test pins their equivalence so CI fails the
// moment the two copies drift, the same role manifest-tools-drift.test.ts
// plays for contracts.tools vs registerTool() in a single plugin.
import { describe, it, expect } from "vitest";
import { checkPermission, type Permissions } from "../../../../plugins/pinchy-email/permissions";
import plugin from "../../../../plugins/pinchy-email/index";
import { getEmailToolsForOperations, EMAIL_READ_TOOLS } from "@/lib/tool-registry";

// Legacy + current email operation vocabulary. "search" and "list" are the
// two pre-#328 per-tool operations that must alias into "read" at BOTH
// layers; "read"/"draft"/"send" are the canonical vocabulary; the empty set
// and an unknown string are included as boundary cases.
const OPERATION_SETS: string[][] = [
  ["read"],
  ["search"],
  ["list"],
  ["draft"],
  ["send"],
  ["search", "draft"],
  ["list", "send"],
  ["read", "search"],
  ["read", "list"],
  [],
  ["bogus"],
];

function pluginGrantsRead(operations: string[]): boolean {
  const permissions: Permissions = { email: operations };
  return checkPermission(permissions, "email", "read");
}

function webGrantsRead(operations: string[]): boolean {
  const tools = getEmailToolsForOperations(operations);
  // "Grants read" at the web layer means the full read toolset is present.
  // getEmailToolsForOperations either pushes the entire EMAIL_READ_TOOLS
  // block or none of it, so checking for any one read tool is equivalent to
  // checking for all of them — but assert the whole block for precision.
  const hasAllReadTools = EMAIL_READ_TOOLS.every((t) => tools.includes(t));
  const hasAnyReadTool = EMAIL_READ_TOOLS.some((t) => tools.includes(t));
  expect(hasAllReadTools).toBe(hasAnyReadTool); // never a partial read grant
  return hasAllReadTools;
}

describe("email-legacy-alias-drift", () => {
  describe.each(OPERATION_SETS.map((operations) => [operations]))("operations=%j", (operations) => {
    it("checkPermission(read) and getEmailToolsForOperations agree on whether 'read' is granted", () => {
      expect(pluginGrantsRead(operations)).toBe(webGrantsRead(operations));
    });

    it("never lets 'search' or 'list' alone unlock 'draft' at either layer", () => {
      if (!operations.includes("search") && !operations.includes("list")) return;
      if (operations.includes("draft") || operations.includes("send")) return;

      const permissions: Permissions = { email: operations };
      expect(checkPermission(permissions, "email", "draft")).toBe(false);

      const tools = getEmailToolsForOperations(operations);
      expect(tools).not.toContain("email_draft");
    });

    it("never lets 'search' or 'list' alone unlock 'send' at either layer", () => {
      if (!operations.includes("search") && !operations.includes("list")) return;
      if (operations.includes("draft") || operations.includes("send")) return;

      const permissions: Permissions = { email: operations };
      expect(checkPermission(permissions, "email", "send")).toBe(false);

      const tools = getEmailToolsForOperations(operations);
      expect(tools).not.toContain("email_send");
    });
  });
});

// ── The set the plugin actually REGISTERS (heypinchy/pinchy#1194) ───────────
//
// Since #1194 the alias rule above decides more than whether a call is
// refused: it decides whether the tool is handed to the model at all. That
// makes a second, stronger equivalence load-bearing — the tool NAMES the
// plugin registers for a grant set must be exactly the names the web side
// derives for it, because `tools.allow` is emitted as the full superset and
// the plugin is the only thing narrowing it per agent.
//
// The check above compares two implementations of one predicate. This one
// compares the plugin's SIX hand-written `lacksGrant(config, "<op>")` lines
// against the one web mapping, so the failure modes that predicate check
// cannot see are covered too:
//
//   - a seventh email tool registered with the factory preamble copy-pasted
//     and no grant check at all: it shows up for every grant set, including
//     the empty one, and #1194 is back;
//   - a tool gated on the WRONG operation (email_draft behind "read"),
//     offered to agents who cannot use it or withheld from agents who can;
//   - a legacy alias that stops widening — `["list"]` losing the read tools
//     is a silent capability loss, not a denial anyone would notice.
//
// It has to live on the web side: the assertion needs BOTH packages, and the
// plugin cannot import web code — hence the `plugin` import at the top.
interface RegisteredTool {
  name: string;
}

interface RegisteredEntry {
  name: string;
  factory: (ctx: { agentId?: string }) => RegisteredTool | null;
}

/**
 * Run the plugin's real `register()` against a config carrying `agents`, and
 * return the factories it handed to OpenClaw, name and all.
 */
function registerPlugin(agents: Record<string, unknown>): RegisteredEntry[] {
  const entries: RegisteredEntry[] = [];
  const api = {
    pluginConfig: {
      apiBaseUrl: "http://pinchy:7777",
      gatewayToken: "drift-guard-token",
      agents,
    },
    registerTool: (
      factory: (ctx: { agentId?: string }) => RegisteredTool | null,
      opts?: { name?: string }
    ) => {
      entries.push({ name: opts?.name ?? "", factory });
    },
  };
  plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);
  return entries;
}

/**
 * The tool names the plugin hands out for an agent holding exactly
 * `operations` — the same path OpenClaw takes when it snapshots an agent's
 * tool list for a run.
 */
function registeredToolNames(operations: string[]): string[] {
  return registerPlugin({
    "agent-1": { connectionId: "conn-1", permissions: { email: operations } },
  })
    .filter((entry) => entry.factory({ agentId: "agent-1" }) !== null)
    .map((entry) => entry.name)
    .sort();
}

describe("email registration-time gating matches the web-derived toolset (#1194)", () => {
  // Corpus floor. Every assertion below is an equality between two sets, and
  // two empty sets are equal — a harness that stopped registering anything
  // (a renamed `register`, a factory that throws) would agree with
  // getEmailToolsForOperations([]) on most rows and read as a clean pass.
  it("hands out every email tool to an agent granted all three operations", () => {
    expect(registeredToolNames(["read", "draft", "send"])).toEqual(
      [
        "email_draft",
        "email_get_attachment",
        "email_list",
        "email_read",
        "email_search",
        "email_send",
      ].sort()
    );
  });

  it.each(OPERATION_SETS.map((operations) => [operations]))(
    "operations=%j registers exactly the web-derived tools",
    (operations) => {
      expect(registeredToolNames(operations)).toEqual(
        [...getEmailToolsForOperations(operations)].sort()
      );
    }
  );

  // The probe path is not a grant decision: OpenClaw calls the factory with no
  // session context at tool-discovery time, and returning null there
  // unregisters the tool for EVERYONE, not just for one unpermitted agent.
  it("still offers every tool to a session-less probe call", () => {
    const entries = registerPlugin({});

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.factory({})).not.toBeNull();
    }
  });
});
