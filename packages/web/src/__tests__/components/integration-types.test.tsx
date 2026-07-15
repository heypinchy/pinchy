import { describe, it, expect } from "vitest";
import {
  INTEGRATION_TYPES,
  isMcpType,
  MCP_TYPE_TO_PRESET,
  getConnectionIcon,
} from "@/components/integration-types";
import {
  OdooIcon,
  GoogleIcon,
  MicrosoftIcon,
  BraveIcon,
  GitHubIcon,
  LinearIcon,
  AtlassianIcon,
  StripeIcon,
  CloudflareIcon,
  IntercomIcon,
  HighLevelIcon,
  McpIcon,
} from "@/components/integration-icons";
import { ImapIcon } from "@/components/imap-icon";

describe("INTEGRATION_TYPES", () => {
  it("includes every native connection type (odoo, google, microsoft, imap, web-search)", () => {
    const ids = INTEGRATION_TYPES.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining(["odoo", "google", "microsoft", "imap", "web-search"])
    );
  });

  it("includes every Phase-1 MCP preset tile plus the custom catch-all", () => {
    const ids = INTEGRATION_TYPES.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "mcp-github",
        "mcp-linear",
        "mcp-atlassian",
        "mcp-stripe",
        "mcp-cloudflare",
        "mcp-intercom",
        "mcp-highlevel",
        "mcp-custom",
      ])
    );
  });

  it("does NOT include Notion or GitLab tiles (OAuth-only, not yet supported — #339, #340)", () => {
    const ids = INTEGRATION_TYPES.map((t) => t.id);
    expect(ids).not.toContain("mcp-notion");
    expect(ids).not.toContain("mcp-gitlab");
  });
});

describe("isMcpType", () => {
  it("returns true for every mcp-* tile id", () => {
    for (const id of Object.keys(MCP_TYPE_TO_PRESET)) {
      expect(isMcpType(id)).toBe(true);
    }
  });

  it("returns false for native type ids and unknown/nullish values", () => {
    expect(isMcpType("odoo")).toBe(false);
    expect(isMcpType("google")).toBe(false);
    expect(isMcpType(undefined)).toBe(false);
    expect(isMcpType(null)).toBe(false);
  });
});

describe("MCP_TYPE_TO_PRESET", () => {
  it("maps every mcp-* tile id to its backend preset discriminator", () => {
    expect(MCP_TYPE_TO_PRESET).toEqual({
      "mcp-github": "github",
      "mcp-linear": "linear",
      "mcp-atlassian": "atlassian",
      "mcp-stripe": "stripe",
      "mcp-cloudflare": "cloudflare",
      "mcp-intercom": "intercom",
      "mcp-highlevel": "highlevel",
      "mcp-custom": "generic",
    });
  });
});

describe("getConnectionIcon", () => {
  it.each([
    ["odoo", undefined, OdooIcon],
    ["google", undefined, GoogleIcon],
    ["microsoft", undefined, MicrosoftIcon],
    ["imap", undefined, ImapIcon],
    ["web-search", undefined, BraveIcon],
  ] as const)("maps non-MCP type %s to its brand icon", (type, preset, expected) => {
    expect(getConnectionIcon(type, preset)).toBe(expected);
  });

  // Regression guard: a naive lookup could fall back to one fixed icon (e.g.
  // Odoo) for every type/preset it doesn't recognize, so a GitHub MCP
  // connection would show the wrong brand mark. Each preset must resolve to
  // its own icon.
  it.each([
    ["github", GitHubIcon],
    ["linear", LinearIcon],
    ["atlassian", AtlassianIcon],
    ["stripe", StripeIcon],
    ["cloudflare", CloudflareIcon],
    ["intercom", IntercomIcon],
    ["highlevel", HighLevelIcon],
    ["generic", McpIcon],
  ] as const)("maps mcp preset %s to its brand icon", (preset, expected) => {
    const icon = getConnectionIcon("mcp", preset);
    expect(icon).toBe(expected);
    expect(icon).not.toBe(OdooIcon);
  });

  it("falls back to the neutral MCP icon for unknown mcp presets", () => {
    expect(getConnectionIcon("mcp", "some-future-preset")).toBe(McpIcon);
  });

  it("falls back to the neutral MCP icon (never silently to Odoo) for unknown connection types", () => {
    expect(getConnectionIcon("some-future-type", undefined)).toBe(McpIcon);
    expect(getConnectionIcon("some-future-type", undefined)).not.toBe(OdooIcon);
  });
});
