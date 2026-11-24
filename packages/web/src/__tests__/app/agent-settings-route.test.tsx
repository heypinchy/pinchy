import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

// Tests the server component itself (app/(app)/chat/[agentId]/settings/page.tsx),
// distinct from agent-settings-page.test.tsx which tests the client
// AgentSettingsPageContent it renders. This is the one place the MCP feature
// flag is actually read from the environment — everything downstream only
// ever sees the resulting `mcpEnabled` prop.
//
// The route is a plain function returning a React element descriptor —
// calling it directly (no render()) never invokes the child component body,
// so this asserts on the returned element's `.props` rather than trying to
// capture props via a rendered mock.

const mockIsMcpEnabled = vi.fn();
vi.mock("@/lib/feature-flags", () => ({
  isMcpEnabled: (...args: unknown[]) => mockIsMcpEnabled(...args),
}));

import AgentSettingsPage from "@/app/(app)/chat/[agentId]/settings/page";

describe("AgentSettingsPage route (server component)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes mcpEnabled=true through when isMcpEnabled() reports the flag on", () => {
    mockIsMcpEnabled.mockReturnValue(true);

    const result = AgentSettingsPage() as ReactElement<{ mcpEnabled?: boolean }>;

    expect(result.props.mcpEnabled).toBe(true);
  });

  it("passes mcpEnabled=false through when isMcpEnabled() reports the flag off", () => {
    mockIsMcpEnabled.mockReturnValue(false);

    const result = AgentSettingsPage() as ReactElement<{ mcpEnabled?: boolean }>;

    expect(result.props.mcpEnabled).toBe(false);
  });

  it("passes mcpEnabled as the only prop — the tab comes from the URL client-side", () => {
    // The active tab is read by useTabParam inside the client tree, so the
    // route must not shadow it with a server-side initial tab.
    mockIsMcpEnabled.mockReturnValue(false);

    const result = AgentSettingsPage() as ReactElement<Record<string, unknown>>;

    expect(result.props).toEqual({ mcpEnabled: false });
  });
});
