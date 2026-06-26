/**
 * Tests for IntegrationTypePicker — the grid of integration tiles shown on
 * the /settings/integrations/new page.
 *
 * Behaviour under test:
 *   - All integration tiles render when the MCP flag is on
 *   - MCP tiles are hidden when the flag is off (Odoo / Google / Web Search remain)
 *   - "Custom MCP server" is visually separated from the named providers
 *   - Singleton tiles (Web Search) render disabled when already configured
 *   - Clicking a tile invokes onSelect with the tile's id
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { IntegrationTypePicker } from "@/components/integration-type-picker";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("IntegrationTypePicker — tile rendering", () => {
  it("renders every integration tile when the MCP flag is on", () => {
    render(<IntegrationTypePicker onSelect={vi.fn()} />);

    // Native / non-MCP integrations
    expect(screen.getByRole("button", { name: /Odoo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Web Search/i })).toBeInTheDocument();
    // MCP integrations shipped in Phase 1 (static-token auth).
    // Notion + GitLab are intentionally absent (#339, #340 — OAuth-only).
    expect(screen.getByRole("button", { name: /^GitHub/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Linear/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Atlassian/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Stripe/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Cloudflare/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Intercom/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^HighLevel/i })).toBeInTheDocument();
    // Catch-all
    expect(screen.getByRole("button", { name: /Custom MCP server/i })).toBeInTheDocument();
  });

  it("does NOT render Notion or GitLab tiles in Phase 1", () => {
    // Both presets were removed because their hosted MCP servers require OAuth
    // (#339, #340). Guard against accidental re-introduction without the
    // corresponding OAuth or REST-plugin landing.
    render(<IntegrationTypePicker onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Notion/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^GitLab/i })).not.toBeInTheDocument();
  });

  it("hides every MCP-backed tile when the MCP flag is off", () => {
    vi.stubEnv("NEXT_PUBLIC_PINCHY_MCP_ENABLED", "0");
    render(<IntegrationTypePicker onSelect={vi.fn()} />);

    // Every MCP-backed tile is gone …
    expect(screen.queryByRole("button", { name: /^GitHub/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Notion/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Linear/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Atlassian/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^GitLab/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stripe/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Cloudflare/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Intercom/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^HighLevel/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Custom MCP server/i })).not.toBeInTheDocument();
    // … non-MCP tiles still render
    expect(screen.getByRole("button", { name: /Odoo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Google/i })).toBeInTheDocument();
  });
});

describe("IntegrationTypePicker — singleton disabled state", () => {
  it("disables the Web Search tile when it is already configured", () => {
    render(<IntegrationTypePicker configuredSingletons={["web-search"]} onSelect={vi.fn()} />);

    const webSearch = screen.getByRole("button", { name: /Web Search/i });
    expect(webSearch).toHaveAttribute("aria-disabled", "true");
  });

  it("does not disable other tiles when a different type is configured", () => {
    render(<IntegrationTypePicker configuredSingletons={["odoo"]} onSelect={vi.fn()} />);

    // Odoo is not a singleton — it stays enabled even when one already exists.
    const odoo = screen.getByRole("button", { name: /Odoo/i });
    expect(odoo).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("IntegrationTypePicker — selection", () => {
  it("calls onSelect with the type id when a tile is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<IntegrationTypePicker onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /^GitHub/i }));

    expect(onSelect).toHaveBeenCalledWith("mcp-github");
  });

  it("calls onSelect with mcp-custom when the Custom MCP server tile is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<IntegrationTypePicker onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /Custom MCP server/i }));

    expect(onSelect).toHaveBeenCalledWith("mcp-custom");
  });

  it("does not call onSelect when a disabled tile is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<IntegrationTypePicker configuredSingletons={["web-search"]} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /Web Search/i }));

    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("IntegrationTypePicker — layout", () => {
  it("renders Custom MCP server visually separated from the named tiles", () => {
    const { container } = render(<IntegrationTypePicker onSelect={vi.fn()} />);

    // The Custom MCP server tile lives in a section with a top border — the
    // same pattern the New-Agent picker uses for "Start from scratch". We
    // assert the structural separation rather than the exact class names.
    const sections = container.querySelectorAll(".border-t");
    expect(sections.length).toBeGreaterThan(0);
    const customSection = Array.from(sections).find((s) =>
      within(s as HTMLElement).queryByRole("button", { name: /Custom MCP server/i })
    );
    expect(customSection).toBeDefined();
  });
});
