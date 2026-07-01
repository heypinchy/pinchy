import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentSettingsDiagnostics } from "@/components/agent-settings-diagnostics";

// Mirror the mock used by settings-support.test.tsx so we can assert *which*
// agent the dialog opens for without exercising the real export flow.
vi.mock("@/components/diagnostics-export-dialog", () => ({
  DiagnosticsExportDialog: ({
    open,
    agentId,
    agentName,
    anchorMessageId,
  }: {
    open: boolean;
    agentId: string;
    agentName: string;
    anchorMessageId?: string;
    onClose: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="diagnostics-export" data-anchor={anchorMessageId ?? "none"}>
        Export dialog for {agentName} ({agentId})
      </div>
    ) : null,
}));

describe("AgentSettingsDiagnostics", () => {
  it("renders the export entry point for the in-context agent without an agent picker", () => {
    render(<AgentSettingsDiagnostics agentId="agt_1" agentName="Smithers" />);

    expect(
      screen.getByRole("button", { name: /generate diagnostics export/i })
    ).toBeInTheDocument();
    // The agent is already in context here — there must be no agent picker.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("opens the export dialog for the in-context agent when Generate is clicked", () => {
    render(<AgentSettingsDiagnostics agentId="agt_42" agentName="Smithers" />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /generate diagnostics export/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent("agt_42");
    expect(dialog).toHaveTextContent("Smithers");
  });

  it("triggers a full-session export, not a per-message one (no anchorMessageId)", () => {
    render(<AgentSettingsDiagnostics agentId="agt_1" agentName="Smithers" />);
    fireEvent.click(screen.getByRole("button", { name: /generate diagnostics export/i }));

    // Settings-triggered exports must NOT anchor on a specific message — that
    // affordance lives on the per-message action bar in chat.
    expect(screen.getByRole("dialog")).toHaveAttribute("data-anchor", "none");
  });
});
