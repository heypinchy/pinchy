// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApprovalConfirmationSection } from "../approval-confirmation-section";

// pinchy_web_search is powerful; odoo_list_models is safe (read-only).
const ALLOWED = ["pinchy_web_search", "odoo_list_models"];

describe("ApprovalConfirmationSection", () => {
  it("renders a checkbox per allowed tool, pre-checked from confirmTools", () => {
    render(
      <ApprovalConfirmationSection
        allowedTools={ALLOWED}
        confirmTools={["pinchy_web_search"]}
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("checkbox", { name: /Search the web/i })).toBeChecked();
  });

  it("toggles a tool into confirmTools", () => {
    const onChange = vi.fn();
    render(
      <ApprovalConfirmationSection allowedTools={ALLOWED} confirmTools={[]} onChange={onChange} />
    );
    fireEvent.click(screen.getByLabelText(/Search the web/i));
    expect(onChange).toHaveBeenCalledWith(["pinchy_web_search"]);
  });

  it("'Use recommended' selects only the powerful tools", () => {
    const onChange = vi.fn();
    render(
      <ApprovalConfirmationSection allowedTools={ALLOWED} confirmTools={[]} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("button", { name: /use recommended/i }));
    expect(onChange).toHaveBeenCalledWith(["pinchy_web_search"]);
  });

  it("shows a hint when the agent has no allowed tools", () => {
    render(<ApprovalConfirmationSection allowedTools={[]} confirmTools={[]} onChange={() => {}} />);
    expect(screen.getByText(/choose which ones require confirmation/i)).toBeInTheDocument();
  });

  // Smithers — the agent every install has — carries exactly two tools, and
  // NEITHER is in TOOL_REGISTRY: the onboarding context tools are granted by
  // personal-agent.ts, not by the grantable-tool catalogue. Filtering the list
  // through the registry therefore rendered an empty section on the default
  // agent, telling the admin to "add tools above" on an agent whose tool list
  // a personal agent cannot change at all. The gate itself never consults the
  // registry — it matches tool names — so anything the agent may call must be
  // offerable here.
  it("offers a tool the agent is allowed to use even when it is not in the registry", () => {
    const onChange = vi.fn();
    render(
      <ApprovalConfirmationSection
        allowedTools={["pinchy_save_user_context"]}
        confirmTools={[]}
        onChange={onChange}
      />
    );
    const box = screen.getByRole("checkbox", { name: /pinchy_save_user_context/i });
    expect(box).toBeInTheDocument();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(["pinchy_save_user_context"]);
  });

  it("keeps a registry-less tool out of 'Use recommended'", () => {
    // "Recommended" means the write/side-effecting tools, which is a property
    // the registry carries. An unknown tool has no category, so it must not be
    // silently swept in — the admin ticks it deliberately or not at all.
    const onChange = vi.fn();
    render(
      <ApprovalConfirmationSection
        allowedTools={["pinchy_web_search", "pinchy_save_user_context"]}
        confirmTools={[]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /use recommended/i }));
    expect(onChange).toHaveBeenCalledWith(["pinchy_web_search"]);
  });
});
