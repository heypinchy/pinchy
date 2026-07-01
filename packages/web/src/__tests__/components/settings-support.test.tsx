import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsSupport } from "@/components/settings-support";

// The per-agent diagnostics export moved to Agent Settings → Diagnostics
// (see agent-settings-diagnostics.tsx). General Settings → Support is now just
// a pointer, so it no longer picks an agent or mounts the export dialog itself.
describe("SettingsSupport", () => {
  it("points users to the agent's Diagnostics tab for the export", () => {
    render(<SettingsSupport />);
    expect(screen.getByText(/Settings → Diagnostics/i)).toBeInTheDocument();
  });

  it("no longer renders the old agent-picker export flow", () => {
    render(<SettingsSupport />);
    expect(
      screen.queryByRole("button", { name: /generate diagnostics export/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
