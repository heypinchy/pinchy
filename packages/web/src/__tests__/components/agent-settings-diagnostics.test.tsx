import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentSettingsDiagnostics } from "@/components/agent-settings-diagnostics";

// The tab renders the real export form inline (no modal), so these tests
// exercise it end to end against mocked transport.
vi.mock("@/lib/api-client", () => ({
  apiPost: vi.fn(async () => ({ schemaVersion: "pinchy.bugreport.v1" })),
  apiGet: vi.fn(async () => ({ chats: [] })),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
      public readonly details?: unknown
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
}));

vi.mock("@/lib/diagnostics/download", () => ({
  downloadBundle: vi.fn(),
  buildBundleFilename: vi.fn(() => "pinchy-bugreport-smithers-19700101-0000.json"),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const CHATS = [
  {
    chatId: null,
    sessionId: "s-default",
    origin: "web" as const,
    writable: true,
    title: "Default chat",
    lastInteractionAt: 1000,
  },
];

describe("AgentSettingsDiagnostics", () => {
  beforeEach(async () => {
    const { apiPost, apiGet } = await import("@/lib/api-client");
    const { downloadBundle } = await import("@/lib/diagnostics/download");
    const { toast } = await import("sonner");
    vi.mocked(apiPost).mockReset();
    vi.mocked(apiPost).mockResolvedValue({ schemaVersion: "pinchy.bugreport.v1" });
    vi.mocked(apiGet).mockReset();
    vi.mocked(apiGet).mockResolvedValue({ chats: CHATS });
    vi.mocked(downloadBundle).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  it("renders the export form inline, not behind a modal", async () => {
    render(<AgentSettingsDiagnostics agentId="agt_1" agentName="Smithers" />);

    // The tab is already the dedicated surface for this one task — the fields
    // must be reachable without opening anything.
    expect(await screen.findByRole("combobox", { name: /chat to export/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/what went wrong/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /generate diagnostics export/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("exports the in-context agent's chat on submit", async () => {
    const { apiPost, apiGet } = await import("@/lib/api-client");
    render(<AgentSettingsDiagnostics agentId="agt_42" agentName="Smithers" />);

    await screen.findByRole("combobox", { name: /chat to export/i });
    expect(apiGet).toHaveBeenCalledWith("/api/agents/agt_42/chats");

    fireEvent.click(screen.getByRole("button", { name: /generate diagnostics export/i }));

    // Settings-triggered exports must NOT anchor on a specific message — that
    // affordance lives on the per-message action bar in chat.
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/diagnostics/export", {
        agentId: "agt_42",
        sessionId: "s-default",
      })
    );
  });

  it("keeps the form usable and clears the description after a successful export", async () => {
    const { downloadBundle } = await import("@/lib/diagnostics/download");
    render(<AgentSettingsDiagnostics agentId="agt_1" agentName="Smithers" />);

    await screen.findByRole("combobox", { name: /chat to export/i });
    const description = screen.getByPlaceholderText(/what went wrong/i);
    fireEvent.change(description, { target: { value: "stream stopped" } });
    fireEvent.click(screen.getByRole("button", { name: /generate diagnostics export/i }));

    await waitFor(() => expect(downloadBundle).toHaveBeenCalled());
    // Nothing closes inline, so the form must reset itself rather than leave a
    // stale description to be resubmitted with the next export.
    await waitFor(() => expect(description).toHaveValue(""));
    expect(
      screen.getByRole("button", { name: /generate diagnostics export/i })
    ).toBeInTheDocument();
  });

  // Inline there is no dialog whose closing signals success, and the download
  // itself is silent. Without this the form just blanks its description and the
  // user is left guessing whether anything happened.
  it("confirms a successful export with a toast, since nothing closes inline", async () => {
    const { toast } = await import("sonner");
    render(<AgentSettingsDiagnostics agentId="agt_1" agentName="Smithers" />);

    await screen.findByRole("combobox", { name: /chat to export/i });
    fireEvent.click(screen.getByRole("button", { name: /generate diagnostics export/i }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Diagnostics export downloaded", {
        description: "pinchy-bugreport-smithers-19700101-0000.json",
      })
    );
  });

  it("offers no Cancel button inline — there is nothing to cancel back to", async () => {
    render(<AgentSettingsDiagnostics agentId="agt_1" agentName="Smithers" />);
    await screen.findByRole("combobox", { name: /chat to export/i });
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeInTheDocument();
  });
});
