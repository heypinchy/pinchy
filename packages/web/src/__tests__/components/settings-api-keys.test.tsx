import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
  };
});

import { apiGet, apiPost, apiDelete, ApiError } from "@/lib/api-client";
import { SettingsApiKeys } from "@/components/settings-api-keys";

/**
 * Matches GET /api/settings/api-keys's masked, org-wide response shape
 * (#572, Task 5.2 / 6.1) — see settings-api-keys.test.ts on the route side.
 */
const mockKeys = [
  {
    id: "key-1",
    name: "CI Deploy",
    start: "pinchy_abc",
    scopes: ["agents:read", "agents:write"],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    lastRequest: null,
    enabled: true,
  },
  {
    id: "key-2",
    name: "Read-only bot",
    start: "pinchy_xyz",
    scopes: ["agents:read"],
    createdAt: "2026-02-01T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
    lastRequest: "2026-03-01T00:00:00.000Z",
    enabled: true,
  },
];

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "New API Key" })).toBeInTheDocument();
  });
  await user.click(screen.getByRole("button", { name: "New API Key" }));
  await waitFor(() => {
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });
}

describe("SettingsApiKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiGet).mockResolvedValue({ keys: mockKeys });
  });

  it("renders the key list from apiGet with masked start and scopes as badges", async () => {
    render(<SettingsApiKeys />);

    await waitFor(() => {
      expect(screen.getByText("CI Deploy")).toBeInTheDocument();
    });

    expect(apiGet).toHaveBeenCalledWith("/api/settings/api-keys");

    const table = screen.getByRole("table");
    const tableView = within(table);
    expect(tableView.getByText("CI Deploy")).toBeInTheDocument();
    expect(tableView.getByText("Read-only bot")).toBeInTheDocument();
    // Masked `start`, never a full secret.
    expect(tableView.getByText(/pinchy_abc/)).toBeInTheDocument();
    expect(tableView.getByText(/pinchy_xyz/)).toBeInTheDocument();
    // Scopes rendered as badges with friendly labels.
    expect(tableView.getAllByText("Read agents").length).toBeGreaterThanOrEqual(1);
    expect(tableView.getByText("Create agents")).toBeInTheDocument();
  });

  it("shows an empty state when there are no keys", async () => {
    vi.mocked(apiGet).mockResolvedValue({ keys: [] });
    render(<SettingsApiKeys />);

    await waitFor(() => {
      expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("opens the create dialog, selects scopes, and submits via apiPost with name/scopes/expiresInDays", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPost).mockResolvedValue({
      id: "key-3",
      key: "pinchy_brandnewsecretvalue",
      name: "New Key",
      scopes: ["agents:read", "agents:write"],
    });
    render(<SettingsApiKeys />);

    await openCreateDialog(user);

    await user.type(screen.getByLabelText("Name"), "New Key");
    await user.click(screen.getByRole("checkbox", { name: "Read agents" }));
    await user.click(screen.getByRole("checkbox", { name: "Create agents" }));
    await user.type(screen.getByLabelText(/expires in/i), "30");

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/api/settings/api-keys", {
        name: "New Key",
        scopes: ["agents:read", "agents:write"],
        expiresInDays: 30,
      });
    });
  });

  it("blocks create with zero scopes selected (Create stays disabled, apiPost never called)", async () => {
    const user = userEvent.setup();
    render(<SettingsApiKeys />);

    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Name"), "No Scopes");

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("★ shows the one-time plaintext key in a dedicated modal with a copy button, and the list never shows it", async () => {
    const user = userEvent.setup();
    const plaintextSecret = "pinchy_shown_exactly_once_12345";
    vi.mocked(apiPost).mockResolvedValue({
      id: "key-3",
      key: plaintextSecret,
      name: "New Key",
      scopes: ["agents:read"],
    });
    const { container } = render(<SettingsApiKeys />);

    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Name"), "New Key");
    await user.click(screen.getByRole("checkbox", { name: "Read agents" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    // The plaintext secret is shown exactly once, in its own modal.
    await waitFor(() => {
      expect(screen.getByText(plaintextSecret)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/only time you.ll see this key/i, { exact: false })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();

    // The create form dialog is gone — replaced by the dedicated one-time modal.
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    // ★ The plaintext must NEVER appear in the list table — only the masked
    // `start` from the refetched list. The table itself is behind the open
    // modal (correctly aria-hidden from role queries while modal), so query
    // the raw DOM node directly rather than via getByRole("table").
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(within(table!).queryByText(plaintextSecret)).not.toBeInTheDocument();
  });

  it("copies the one-time key to the clipboard when Copy is clicked", async () => {
    const user = userEvent.setup();
    const plaintextSecret = "pinchy_copyme_secret_value";
    vi.mocked(apiPost).mockResolvedValue({
      id: "key-3",
      key: plaintextSecret,
      name: "New Key",
      scopes: ["agents:read"],
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });

    render(<SettingsApiKeys />);
    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Name"), "New Key");
    await user.click(screen.getByRole("checkbox", { name: "Read agents" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByText(plaintextSecret)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(plaintextSecret);
    });
  });

  it("★ clears the one-time plaintext key from state once its modal is dismissed", async () => {
    const user = userEvent.setup();
    const plaintextSecret = "pinchy_dismiss_me_secret_value";
    vi.mocked(apiPost).mockResolvedValue({
      id: "key-3",
      key: plaintextSecret,
      name: "New Key",
      scopes: ["agents:read"],
    });
    render(<SettingsApiKeys />);

    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Name"), "New Key");
    await user.click(screen.getByRole("checkbox", { name: "Read agents" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByText(plaintextSecret)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Done" }));

    // Once dismissed, the plaintext must be gone from the DOM entirely — it
    // must not linger anywhere else (transient state only).
    await waitFor(() => {
      expect(screen.queryByText(plaintextSecret)).not.toBeInTheDocument();
    });
  });

  it("opens the revoke confirmation and calls apiDelete with the key id on confirm", async () => {
    const user = userEvent.setup();
    vi.mocked(apiDelete).mockResolvedValue({ success: true });
    render(<SettingsApiKeys />);

    await waitFor(() => {
      expect(screen.getByText("CI Deploy")).toBeInTheDocument();
    });

    const table = screen.getByRole("table");
    const row = within(table).getByText("CI Deploy").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(apiDelete).toHaveBeenCalledWith("/api/settings/api-keys/key-1");
    });
  });

  it("shows an error toast when revoke fails", async () => {
    const user = userEvent.setup();
    vi.mocked(apiDelete).mockRejectedValue(new ApiError(500, "Failed to revoke API key"));
    render(<SettingsApiKeys />);

    await waitFor(() => {
      expect(screen.getByText("CI Deploy")).toBeInTheDocument();
    });

    const table = screen.getByRole("table");
    const row = within(table).getByText("CI Deploy").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to revoke API key");
    });
  });

  it("shows a field error and keeps the dialog open when create fails with 400 fieldErrors", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPost).mockRejectedValue(
      new ApiError(400, "Validation failed", { fieldErrors: { name: ["Name is required"] } })
    );
    render(<SettingsApiKeys />);

    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Name"), "x");
    await user.click(screen.getByRole("checkbox", { name: "Read agents" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument();
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });
});
