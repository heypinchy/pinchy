// @vitest-environment node
//
// REGRESSION (real incident): index.ts used to statically import all three
// adapters (GmailAdapter, GraphAdapter, ImapAdapter) at module top level.
// Each adapter module pulls in its own third-party SDK at ITS top level
// (gmail-adapter.js -> googleapis, imap-adapter.js -> imapflow). When
// googleapis was missing at runtime, `import "./gmail-adapter.js"` threw
// `Cannot find module 'googleapis'` while index.ts itself was being
// evaluated — so the ENTIRE plugin module failed to load and none of the 6
// registerTool() calls ran. Every email tool vanished, including the IMAP
// tools that don't even use googleapis.
//
// This file proves the fix: adapter modules are imported dynamically, per
// connection type, inside getOrCreateClient — so a broken/missing adapter
// dependency is isolated to that provider's dispatch and never crashes
// plugin load or another provider's tools.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Simulate a broken Gmail adapter dependency: the mock factory itself
// throws, so ANY attempt to resolve "../gmail-adapter" (equivalently,
// index.ts's "./gmail-adapter.js") rejects — exactly like gmail-adapter.ts's
// real top-level `import { google } from "googleapis"` throwing because the
// package is missing.
//
// This is deliberately the harshest possible failure mode: on OLD
// (pre-fix) index.ts, which statically imports GmailAdapter at module top
// level, this factory throwing means `import plugin from "../index"` below
// never resolves — the whole test FILE fails to load, not just one test.
// That collection-level crash is exactly the incident this plugin hardening
// exists to prevent: one broken adapter dependency silently vanishing every
// email tool, including providers (IMAP) that never touch googleapis. On
// NEW (fixed) index.ts, importing index.ts never touches gmail-adapter at
// all — the throwing factory only fires later, inside a single test's
// google-dispatch call, isolated from everything else in this file.
//
// vitest's mocker wraps ANY factory throw in a generic "did you forget
// vi.hoisted()" message and discards the original text (see
// @vitest/mocker's createHelpfulError) — so the wrapped error surfacing
// from index.ts's catch block below will NOT literally contain
// "googleapis". That's a vitest implementation detail, not something this
// test needs to assert on; what matters is that the error is isolated,
// actionable, and doesn't crash anything else.
vi.mock("../gmail-adapter", () => {
  throw new Error("Cannot find module 'googleapis'");
});

// IMAP must stay healthy so we can prove it survives Gmail's outage.
const mockImapList = vi.fn();
vi.mock("../imap-adapter", () => {
  const MockImapAdapter = vi.fn(function (this: Record<string, unknown>) {
    this.list = mockImapList;
  });
  return { ImapAdapter: MockImapAdapter };
});

// Importing index.ts must NOT throw even though gmail-adapter is broken —
// this only holds if index.ts never statically imports GmailAdapter.
import plugin from "../index";

interface AgentTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: { error?: string };
  }>;
}

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<string, { connectionId: string; permissions: Record<string, string[]> }>;
}

const testConfig: PluginConfig = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-gateway-token",
  agents: {
    "agent-google": {
      connectionId: "conn-google",
      permissions: { email: ["read"] },
    },
    "agent-imap": {
      connectionId: "conn-imap",
      permissions: { email: ["read"] },
    },
  },
};

function createApi(pluginConfig: PluginConfig = testConfig) {
  const tools: Array<{
    factory: (ctx: { agentId?: string }) => AgentTool | null;
    name: string;
  }> = [];
  const api = {
    pluginConfig,
    registerTool: (
      factory: (ctx: { agentId?: string }) => AgentTool | null,
      opts?: { name?: string }
    ) => {
      tools.push({ factory, name: opts?.name ?? "" });
    },
  };
  // Cast at the seam: the plugin's real ContentBlock has an optional `text`
  // (file blocks omit it), which the local AgentTool mirror declares required.
  plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);
  return tools;
}

function findTool(tools: ReturnType<typeof createApi>, name: string, agentId: string): AgentTool {
  const entry = tools.find((t) => t.name === name);
  if (!entry) throw new Error(`tool ${name} was not registered`);
  const tool = entry.factory({ agentId });
  if (!tool) throw new Error(`tool ${name} factory returned null for ${agentId}`);
  return tool;
}

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockCredentialsFor(connectionId: string, type: string, credentials: unknown) {
  mockFetch.mockImplementation(async (url: unknown) => {
    if (String(url).includes(`/integrations/${connectionId}/credentials`)) {
      return { ok: true, json: async () => ({ type, credentials }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

describe("adapter dynamic loading resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("register() still registers all 6 tools even though the Gmail adapter module cannot be loaded", () => {
    const tools = createApi();
    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "email_list",
        "email_read",
        "email_search",
        "email_draft",
        "email_send",
        "email_get_attachment",
      ])
    );
  });

  it("dispatching a google connection surfaces an actionable 'failed to initialize' error instead of crashing the plugin", async () => {
    mockCredentialsFor("conn-google", "google", { accessToken: "tok" });
    const tools = createApi();
    const tool = findTool(tools, "email_list", "agent-google");

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "The google email integration failed to initialize (a required module could not be loaded)"
    );
    // Audit-integrity contract (#404): details.error must mirror content[0].text.
    expect(result.details?.error).toBe(result.content[0].text);
  });

  it("dispatching an IMAP connection still works even though the Gmail adapter is broken", async () => {
    mockCredentialsFor("conn-imap", "imap", {
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      username: "user@example.com",
      password: "app-password",
      security: "tls",
    });
    mockImapList.mockResolvedValue([]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", "agent-imap");

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBeFalsy();
    expect(mockImapList).toHaveBeenCalledTimes(1);
  });
});

describe("index.ts source has no static top-level adapter imports", () => {
  it("only reaches GmailAdapter/GraphAdapter/ImapAdapter via a dynamic import() in getOrCreateClient", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "..", "index.ts"), "utf8");

    // A static top-level import would pull in the adapter's third-party SDK
    // the moment index.ts is loaded — the exact failure mode this file
    // guards against.
    expect(source).not.toMatch(/^import\s*\{[^}]*GmailAdapter[^}]*\}\s*from/m);
    expect(source).not.toMatch(/^import\s*\{[^}]*GraphAdapter[^}]*\}\s*from/m);
    expect(source).not.toMatch(/^import\s*\{[^}]*ImapAdapter[^}]*\}\s*from/m);

    // Each adapter must instead be reachable via a dynamic import() so a
    // broken dependency is only discovered at dispatch time.
    expect(source).toContain('await import("./gmail-adapter.js")');
    expect(source).toContain('await import("./graph-adapter.js")');
    expect(source).toContain('await import("./imap-adapter.js")');
  });
});
