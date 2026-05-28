import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DiagnosticsExportDialog } from "@/components/diagnostics-export-dialog";

vi.mock("@/lib/api-client", () => ({
  apiPost: vi.fn(async () => ({ schemaVersion: "pinchy.bugreport.v1" })),
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
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("DiagnosticsExportDialog", () => {
  beforeEach(async () => {
    const { apiPost } = await import("@/lib/api-client");
    const { downloadBundle, buildBundleFilename } = await import("@/lib/diagnostics/download");
    const { toast } = await import("sonner");
    vi.mocked(apiPost).mockClear();
    vi.mocked(apiPost).mockResolvedValue({ schemaVersion: "pinchy.bugreport.v1" });
    vi.mocked(downloadBundle).mockClear();
    vi.mocked(buildBundleFilename).mockClear();
    vi.mocked(buildBundleFilename).mockReturnValue("pinchy-bugreport-smithers-19700101-0000.json");
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  it("renders the generate button and What's included link", () => {
    render(
      <DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={() => {}} />
    );
    expect(screen.getByRole("button", { name: /generate/i })).toBeInTheDocument();
    expect(screen.getByText(/what's included/i)).toBeInTheDocument();
  });

  it("calls the API with agentId and optional userDescription on Generate click", async () => {
    const { apiPost } = await import("@/lib/api-client");
    render(
      <DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={() => {}} />
    );
    fireEvent.change(screen.getByPlaceholderText(/what went wrong/i), {
      target: { value: "stream stopped" },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/diagnostics/export", {
        agentId: "agt_1",
        userDescription: "stream stopped",
      })
    );
  });

  it("passes anchorMessageId through when provided", async () => {
    const { apiPost } = await import("@/lib/api-client");
    render(
      <DiagnosticsExportDialog
        open
        agentId="agt_1"
        agentName="Smithers"
        anchorMessageId="msg_x"
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/diagnostics/export", {
        agentId: "agt_1",
        anchorMessageId: "msg_x",
      })
    );
  });

  it("shows a v1-limitation notice when anchorMessageId is set (per-message export)", () => {
    render(
      <DiagnosticsExportDialog
        open
        agentId="agt_1"
        agentName="Smithers"
        anchorMessageId="msg_x"
        onClose={() => {}}
      />
    );
    // Per-message export currently includes the last 10 turns, not a slice
    // anchored on the clicked message — surface this to the user so they're
    // not surprised.
    expect(screen.getByText(/last 10 turns/i)).toBeInTheDocument();
  });

  it("does not show the v1-limitation notice when no anchorMessageId is set (Settings export)", () => {
    render(
      <DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={() => {}} />
    );
    expect(screen.queryByText(/last 10 turns/i)).not.toBeInTheDocument();
  });

  it("shows inline validation error and does not call the API when userDescription exceeds 500 chars", async () => {
    const { apiPost } = await import("@/lib/api-client");
    render(
      <DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={() => {}} />
    );
    const tooLong = "x".repeat(501);
    fireEvent.change(screen.getByPlaceholderText(/what went wrong/i), {
      target: { value: tooLong },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    expect(await screen.findByText(/500 characters or fewer/i)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("shows a toast error on ApiError and keeps the dialog open", async () => {
    const { apiPost, ApiError } = await import("@/lib/api-client");
    const { toast } = await import("sonner");
    const onClose = vi.fn();
    vi.mocked(apiPost).mockRejectedValueOnce(new ApiError(500, "boom"));
    render(<DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("downloads the bundle and closes on success", async () => {
    const { downloadBundle, buildBundleFilename } = await import("@/lib/diagnostics/download");
    const onClose = vi.fn();
    render(<DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(downloadBundle).toHaveBeenCalled());
    expect(buildBundleFilename).toHaveBeenCalledWith("Smithers", expect.any(Date));
    expect(downloadBundle).toHaveBeenCalledWith(
      { schemaVersion: "pinchy.bugreport.v1" },
      "pinchy-bugreport-smithers-19700101-0000.json"
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
