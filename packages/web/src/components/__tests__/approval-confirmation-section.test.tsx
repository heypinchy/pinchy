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
});
