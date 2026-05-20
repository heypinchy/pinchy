import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsSupport } from "@/components/settings-support";

vi.mock("@/components/diagnostics-export-dialog", () => ({
  DiagnosticsExportDialog: ({
    open,
    agentId,
    agentName,
  }: {
    open: boolean;
    agentId: string;
    agentName: string;
    onClose: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="diagnostics-export">
        Export dialog for {agentName} ({agentId})
      </div>
    ) : null,
}));

describe("SettingsSupport", () => {
  it("auto-selects when user has only one accessible agent", () => {
    render(<SettingsSupport agents={[{ id: "agt_1", name: "Smithers" }]} />);
    expect(screen.getByText(/smithers/i)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows an agent picker when multiple agents are accessible", () => {
    render(
      <SettingsSupport
        agents={[
          { id: "a", name: "A" },
          { id: "b", name: "B" },
        ]}
      />
    );
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("opens DiagnosticsExportDialog when Generate is clicked", () => {
    render(<SettingsSupport agents={[{ id: "agt_1", name: "Smithers" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /generate diagnostics export/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renders an empty state when no agents are accessible", () => {
    render(<SettingsSupport agents={[]} />);
    expect(screen.getByText(/don't have access to any agents yet/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /generate diagnostics export/i })
    ).not.toBeInTheDocument();
  });
});
