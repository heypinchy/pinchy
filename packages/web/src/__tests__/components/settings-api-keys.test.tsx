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
    start: "pinchy_a1b2c3",
    scopes: ["agents:read", "agents:write"],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    lastRequest: null,
    enabled: true,
    createdBy: { id: "admin-1", name: "Cara Admin", active: true },
  },
  {
    id: "key-2",
    name: "Read-only bot",
    start: "pinchy_x9y8z7",
    scopes: ["agents:read"],
    createdAt: "2026-02-01T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
    lastRequest: "2026-03-01T00:00:00.000Z",
    enabled: true,
    createdBy: { id: "admin-2", name: "Dara Admin", active: true },
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
    // Masked `start`, never a full secret. The two rows must read DIFFERENTLY:
    // this column's whole job is telling keys apart, and it silently stopped
    // doing it once (the plugin's default masked away the random part, leaving
    // every key as "pinchy"). Fixtures can't prove the value is real — that's
    // auth-apikey.integration.test.ts's job, against a genuinely created key —
    // but they can at least pin that the component renders per-row values
    // rather than something constant.
    expect(tableView.getByText(/pinchy_a1b2c3/)).toBeInTheDocument();
    expect(tableView.getByText(/pinchy_x9y8z7/)).toBeInTheDocument();
    // Scopes rendered as badges with friendly labels.
    expect(tableView.getAllByText("Read agents").length).toBeGreaterThanOrEqual(1);
    expect(tableView.getByText("Create agents")).toBeInTheDocument();
    // Provenance: who created each key.
    expect(tableView.getByText("Cara Admin")).toBeInTheDocument();
    expect(tableView.getByText("Dara Admin")).toBeInTheDocument();
  });

  // ── The compensating control for Model-2 custody ─────────────────────────
  //
  // A key belongs to the org and keeps working after its creator leaves — by
  // design. But only that creator ever saw the plaintext, so a departure is
  // exactly when someone should decide whether to rotate. Nothing forces that
  // decision; this column is what prompts it. If these tests go, so does the
  // only thing making the custody trade-off visible.

  it("flags keys whose creator is no longer active, and leaves serving admins' keys unflagged", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      keys: [
        mockKeys[0],
        { ...mockKeys[1], createdBy: { id: "admin-2", name: "Dara Admin", active: false } },
      ],
    });
    render(<SettingsApiKeys />);

    await waitFor(() => {
      expect(screen.getByText("Dara Admin")).toBeInTheDocument();
    });

    const rows = screen.getAllByRole("row");
    const daraRow = rows.find((r) => within(r).queryByText("Dara Admin"));
    const caraRow = rows.find((r) => within(r).queryByText("Cara Admin"));

    expect(within(daraRow!).getByText(/consider rotating/i)).toBeInTheDocument();
    // Exactly one flag — a departed creator must not smear onto every row.
    expect(within(caraRow!).queryByText(/consider rotating/i)).not.toBeInTheDocument();
  });

  it("renders 'Unknown' rather than guessing when a key has no creator recorded", async () => {
    // Keys issued before provenance was recorded. Honest beats plausible: the
    // admin has to know this one can't be traced, not be shown a blank cell
    // they'd read as "nobody".
    vi.mocked(apiGet).mockResolvedValue({ keys: [{ ...mockKeys[0], createdBy: null }] });
    render(<SettingsApiKeys />);

    await waitFor(() => {
      expect(screen.getByText("CI Deploy")).toBeInTheDocument();
    });

    expect(within(screen.getByRole("table")).getByText("Unknown")).toBeInTheDocument();
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
  // ── A failed load must not masquerade as an empty list ───────────────────

  it("shows a load failure instead of claiming there are no keys", async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new ApiError(500, "Database unreachable"));

    render(<SettingsApiKeys />);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Database unreachable");
    });

    // THE assertion. The toast is transient; what stays on screen is what the
    // admin acts on. "No API keys yet." would be the UI stating a fact it does
    // not have — and an admin who believes it and issues a "replacement" has
    // added a second live org credential while the first is still valid and
    // unlisted.
    expect(screen.queryByText(/No API keys yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't load your API keys/i)).toBeInTheDocument();
  });

  it("recovers when the retry succeeds", async () => {
    const user = userEvent.setup();
    vi.mocked(apiGet).mockRejectedValueOnce(new ApiError(500, "Database unreachable"));

    render(<SettingsApiKeys />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    });

    vi.mocked(apiGet).mockResolvedValue({ keys: mockKeys });
    await user.click(screen.getByRole("button", { name: /try again/i }));

    // A dead end would leave a reload as the only way out.
    await waitFor(() => {
      expect(screen.getByText("CI Deploy")).toBeInTheDocument();
    });
    expect(screen.queryByText(/couldn't load your API keys/i)).not.toBeInTheDocument();
  });

  it("still shows the empty state when the list is genuinely empty", async () => {
    vi.mocked(apiGet).mockResolvedValue({ keys: [] });

    render(<SettingsApiKeys />);

    // The other half of the distinction: an empty list is a fact worth stating.
    await waitFor(() => {
      expect(screen.getByText(/No API keys yet/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/couldn't load your API keys/i)).not.toBeInTheDocument();
  });

  // ── The scopes error has to reach a screen reader ────────────────────────

  it("wires the scopes validation error to the checkbox group", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPost).mockRejectedValueOnce(
      new ApiError(400, "Validation failed", {
        fieldErrors: { scopes: ["Pick at least one scope"] },
      })
    );

    render(<SettingsApiKeys />);
    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Name"), "CI");
    // A scope has to be selected or Create stays disabled, so in practice this
    // error arrives from the SERVER — client/server skew, e.g. a scope the enum
    // no longer accepts. (handleCreate also sets it defensively.) Skew is
    // exactly the case where the user cannot guess what went wrong, so the
    // error has to be announced rather than merely displayed nearby.
    await user.click(screen.getByRole("checkbox", { name: "Read agents" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    const group = await screen.findByRole("group", { name: "Scopes" });
    // The name and expires fields both wire aria-describedby to their error.
    // A checkbox group has no single control to hang one on, so without an
    // explicit group it was an orphan <Label> and an error the assistive tree
    // never reached: the form just appeared to refuse to submit.
    const errorId = group.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();
    expect(document.getElementById(errorId!)).toHaveTextContent("Pick at least one scope");
  });
});
