import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DiagnosticsExportDialog } from "@/components/diagnostics-export-dialog";

vi.mock("@/lib/api-client", () => ({
  apiPost: vi.fn(async () => ({ schemaVersion: "pinchy.bugreport.v1" })),
  // The chat picker (#639) fetches the user's chats on open. Default to an
  // empty list so the legacy tests below export the default chat (no sessionId).
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
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("DiagnosticsExportDialog", () => {
  beforeEach(async () => {
    const { apiPost, apiGet } = await import("@/lib/api-client");
    const { downloadBundle, buildBundleFilename } = await import("@/lib/diagnostics/download");
    const { toast } = await import("sonner");
    vi.mocked(apiPost).mockClear();
    vi.mocked(apiPost).mockResolvedValue({ schemaVersion: "pinchy.bugreport.v1" });
    vi.mocked(apiGet).mockReset();
    vi.mocked(apiGet).mockResolvedValue({ chats: [] });
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

  // The download itself is silent — the browser may drop the file straight into
  // the downloads folder with no visible tab. Name the file we produced so the
  // user can find it, on both surfaces (inline, nothing closes at all).
  it("confirms the download with a toast naming the file", async () => {
    const { toast } = await import("sonner");
    render(
      <DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={() => {}} />
    );
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Diagnostics export downloaded", {
        description: "pinchy-bugreport-smithers-19700101-0000.json",
      })
    );
  });

  // The whole point of the form's `onSubmittingChange` plumbing: an export in
  // flight must not be closed out from under itself, or the download is lost
  // with no explanation. Nothing else covers this.
  it("refuses to close on Escape while an export is in flight", async () => {
    const { apiPost } = await import("@/lib/api-client");
    const onClose = vi.fn();
    let resolveExport: (bundle: unknown) => void = () => {};
    vi.mocked(apiPost).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveExport = resolve;
      })
    );

    render(<DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    // Wait for the in-flight state to reach the dialog, otherwise Escape would
    // race the click and pass for the wrong reason.
    await waitFor(() => expect(screen.getByRole("button", { name: /generating/i })).toBeDisabled());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // Once it lands, the dialog closes on its own — the guard must not be sticky.
    resolveExport({ schemaVersion: "pinchy.bugreport.v1" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // ── #639: chat picker + context-aware default selection ──────────────────

  const CHATS = [
    {
      chatId: null,
      sessionId: "s-default",
      origin: "web" as const,
      writable: true,
      title: "Default chat",
      lastInteractionAt: 1000,
    },
    {
      chatId: "chat-x",
      sessionId: "s-x",
      origin: "web" as const,
      writable: true,
      title: "Quarterly report",
      lastInteractionAt: 5000,
    },
    {
      chatId: null,
      sessionId: "s-tg",
      origin: "telegram" as const,
      writable: false,
      title: "Telegram chat",
      lastInteractionAt: 3000,
    },
  ];

  it("renders a chat selector populated from the chats API", async () => {
    const { apiGet } = await import("@/lib/api-client");
    vi.mocked(apiGet).mockResolvedValue({ chats: CHATS });
    render(
      <DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={() => {}} />
    );
    expect(await screen.findByRole("combobox", { name: /chat/i })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith("/api/agents/agt_1/chats");
  });

  it("constrains the chat picker to the dialog width so a long title can't stretch it", async () => {
    const { apiGet } = await import("@/lib/api-client");
    vi.mocked(apiGet).mockResolvedValue({
      chats: [{ ...CHATS[0], title: "Sind jetzt alle gebuchten Rechnungen mit Bankbuchungen " }],
    });
    render(
      <DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={() => {}} />
    );
    // The shadcn trigger defaults to `w-fit` + `whitespace-nowrap`, so a long
    // chat title used to push the trigger — and with it the dialog's grid
    // column — far past the dialog's own max-width, spilling the picker and the
    // textarea out of the modal. jsdom computes no layout, so guard the classes
    // that make the trigger shrinkable.
    const trigger = await screen.findByRole("combobox", { name: /chat/i });
    expect(trigger).toHaveClass("w-full");
    expect(trigger).toHaveClass("min-w-0");
  });

  it("exports the default chat's sessionId when launched from Settings (no chat context)", async () => {
    const { apiGet, apiPost } = await import("@/lib/api-client");
    vi.mocked(apiGet).mockResolvedValue({ chats: CHATS });
    render(
      <DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={() => {}} />
    );
    await screen.findByRole("combobox", { name: /chat/i });
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/diagnostics/export", {
        agentId: "agt_1",
        sessionId: "s-default",
      })
    );
  });

  it("preselects and exports the active chat's sessionId from chat context", async () => {
    const { apiGet, apiPost } = await import("@/lib/api-client");
    vi.mocked(apiGet).mockResolvedValue({ chats: CHATS });
    render(
      <DiagnosticsExportDialog
        open
        agentId="agt_1"
        agentName="Smithers"
        chatId="chat-x"
        onClose={() => {}}
      />
    );
    await screen.findByRole("combobox", { name: /chat/i });
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/diagnostics/export", {
        agentId: "agt_1",
        sessionId: "s-x",
      })
    );
  });

  it("falls back to the most-recent chat when no chat matches the active/default (avoids a silent wrong-chat/404 export)", async () => {
    const { apiGet, apiPost } = await import("@/lib/api-client");
    // Settings launch (no chatId) but the user has NO default web chat — only a
    // named chat and a Telegram chat. Server returns most-recent first.
    vi.mocked(apiGet).mockResolvedValue({
      chats: [
        {
          chatId: "chat-x",
          sessionId: "s-x",
          origin: "web" as const,
          writable: true,
          title: "Quarterly report",
          lastInteractionAt: 5000,
        },
        {
          chatId: null,
          sessionId: "s-tg",
          origin: "telegram" as const,
          writable: false,
          title: "Telegram chat",
          lastInteractionAt: 3000,
        },
      ],
    });
    render(
      <DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={() => {}} />
    );
    await screen.findByRole("combobox", { name: /chat/i });
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/diagnostics/export", {
        agentId: "agt_1",
        sessionId: "s-x",
      })
    );
  });

  it("falls back to a default export (no sessionId) when the chats list fails to load", async () => {
    const { apiGet, apiPost } = await import("@/lib/api-client");
    vi.mocked(apiGet).mockRejectedValue(new Error("chats unreachable"));
    render(
      <DiagnosticsExportDialog open agentId="agt_1" agentName="Smithers" onClose={() => {}} />
    );
    // No selector renders when the list is empty/unavailable; Generate still works.
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/diagnostics/export", { agentId: "agt_1" })
    );
  });
});
