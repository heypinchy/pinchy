import { describe, it, expect } from "vitest";
import { getConnectionIcon } from "../integration-types";
import {
  OdooIcon,
  GoogleIcon,
  BraveIcon,
  GitHubIcon,
  LinearIcon,
  AtlassianIcon,
  StripeIcon,
  CloudflareIcon,
  IntercomIcon,
  HighLevelIcon,
  McpIcon,
} from "../integration-icons";

describe("getConnectionIcon", () => {
  it.each([
    ["odoo", undefined, OdooIcon],
    ["google", undefined, GoogleIcon],
    ["web-search", undefined, BraveIcon],
  ] as const)("maps non-MCP type %s to its brand icon", (type, preset, expected) => {
    expect(getConnectionIcon(type, preset)).toBe(expected);
  });

  // Regression guard: the integrations card used to fall back to OdooIcon
  // for every type it didn't know, so a GitHub MCP connection showed the
  // Odoo logo. Each preset must resolve to its own brand icon.
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

  it("never falls back to the Odoo logo for unknown connection types", () => {
    expect(getConnectionIcon("some-future-type", undefined)).not.toBe(OdooIcon);
  });
});
