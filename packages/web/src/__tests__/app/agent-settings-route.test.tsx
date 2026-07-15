import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

// Tests the server component itself (app/(app)/chat/[agentId]/settings/page.tsx),
// distinct from agent-settings-page.test.tsx which tests the client
// AgentSettingsPageContent it renders. This is the one place the MCP feature
// flag is actually read from the environment — everything downstream only
// ever sees the resulting `mcpEnabled` prop (see
// docs/plans/2026-06-30-mcp-port-to-main.md Task T8).
//
// The route is a plain async function returning a React element descriptor —
// calling it directly (no render()) never invokes the child component body,
// so this asserts on the returned element's `.props` rather than trying to
// capture props via a rendered mock (usage-page.test.tsx's pattern only
// checks the result is defined; this goes one step further and reads props).

const mockIsMcpEnabled = vi.fn();
vi.mock("@/lib/feature-flags", () => ({
  isMcpEnabled: (...args: unknown[]) => mockIsMcpEnabled(...args),
}));

import AgentSettingsPage from "@/app/(app)/chat/[agentId]/settings/page";

describe("AgentSettingsPage route (server component)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes mcpEnabled=true through when isMcpEnabled() reports the flag on", async () => {
    mockIsMcpEnabled.mockReturnValue(true);

    const result = (await AgentSettingsPage({
      searchParams: Promise.resolve({}),
    })) as ReactElement<{ mcpEnabled?: boolean }>;

    expect(result.props.mcpEnabled).toBe(true);
  });

  it("passes mcpEnabled=false through when isMcpEnabled() reports the flag off", async () => {
    mockIsMcpEnabled.mockReturnValue(false);

    const result = (await AgentSettingsPage({
      searchParams: Promise.resolve({}),
    })) as ReactElement<{ mcpEnabled?: boolean }>;

    expect(result.props.mcpEnabled).toBe(false);
  });

  it("still forwards the tab search param alongside mcpEnabled", async () => {
    mockIsMcpEnabled.mockReturnValue(false);

    const result = (await AgentSettingsPage({
      searchParams: Promise.resolve({ tab: "permissions" }),
    })) as ReactElement<{ initialTab?: string }>;

    expect(result.props.initialTab).toBe("permissions");
  });
});
