// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApprovalConfirmationSection } from "../approval-confirmation-section";
import type { ConfirmMap } from "@/lib/approvals/policy";

// pinchy_web_search is powerful; odoo_list_models is safe (read-only).
const ALLOWED = ["pinchy_web_search", "odoo_list_models"];

describe("ApprovalConfirmationSection", () => {
  it("renders a checkbox per allowed tool, pre-checked from the policy", () => {
    render(
      <ApprovalConfirmationSection
        allowedTools={ALLOWED}
        confirm={{ pinchy_web_search: "confirm" }}
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("checkbox", { name: /Search the web/i })).toBeChecked();
  });

  it("toggles a tool into the policy", () => {
    const onChange = vi.fn();
    render(<ApprovalConfirmationSection allowedTools={ALLOWED} confirm={{}} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/Search the web/i));
    expect(onChange).toHaveBeenCalledWith({ pinchy_web_search: "confirm" });
  });

  it("removes the key when a tool is unticked", () => {
    const onChange = vi.fn();
    render(
      <ApprovalConfirmationSection
        allowedTools={ALLOWED}
        confirm={{ pinchy_web_search: "confirm" }}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByLabelText(/Search the web/i));
    expect(onChange).toHaveBeenCalledWith({});
  });

  it("'Use recommended' selects only the powerful tools", () => {
    const onChange = vi.fn();
    render(<ApprovalConfirmationSection allowedTools={ALLOWED} confirm={{}} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /use recommended/i }));
    expect(onChange).toHaveBeenCalledWith({ pinchy_web_search: "confirm" });
  });

  // A per-model exception is a decision someone made about a specific record
  // type, in a different part of the page. A one-click default for the TOOL
  // level has no business discarding it.
  it("'Use recommended' leaves per-model exceptions alone", () => {
    const onChange = vi.fn();
    const confirm: ConfirmMap = { "odoo_delete:note.note": "allow" };
    render(
      <ApprovalConfirmationSection allowedTools={ALLOWED} confirm={confirm} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("button", { name: /use recommended/i }));
    expect(onChange).toHaveBeenCalledWith({
      pinchy_web_search: "confirm",
      "odoo_delete:note.note": "allow",
    });
  });

  it("shows a hint when the agent has no allowed tools", () => {
    render(<ApprovalConfirmationSection allowedTools={[]} confirm={{}} onChange={() => {}} />);
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
        confirm={{}}
        onChange={onChange}
      />
    );
    const box = screen.getByRole("checkbox", { name: /pinchy_save_user_context/i });
    expect(box).toBeInTheDocument();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith({ pinchy_save_user_context: "confirm" });
  });

  it("keeps a registry-less tool out of 'Use recommended'", () => {
    // "Recommended" means the write/side-effecting tools, which is a property
    // the registry carries. An unknown tool has no category, so it must not be
    // silently swept in — the admin ticks it deliberately or not at all.
    const onChange = vi.fn();
    render(
      <ApprovalConfirmationSection
        allowedTools={["pinchy_web_search", "pinchy_save_user_context"]}
        confirm={{}}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /use recommended/i }));
    expect(onChange).toHaveBeenCalledWith({ pinchy_web_search: "confirm" });
  });
});
