import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AuditLogTable } from "@/components/audit-log-table";

describe("AuditLogTable", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockEntries = [
    {
      id: 1,
      timestamp: "2026-02-21T10:00:00.000Z",
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      resource: null,
      detail: { email: "admin@example.com" },
      rowHmac: "abc123",
    },
    {
      id: 2,
      timestamp: "2026-02-21T11:00:00.000Z",
      actorType: "user",
      actorId: "user-2",
      eventType: "agent.created",
      resource: "agent-1",
      detail: { name: "Smithers" },
      rowHmac: "def456",
    },
    {
      id: 3,
      timestamp: "2026-02-21T12:00:00.000Z",
      actorType: "user",
      actorId: "user-3",
      eventType: "auth.denied",
      resource: null,
      detail: { reason: "Invalid credentials" },
      rowHmac: "ghi789",
    },
  ];

  const mockAuditResponse = {
    entries: mockEntries,
    total: 3,
    page: 1,
    limit: 50,
  };

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function renderWithEntriesLoaded() {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockAuditResponse,
    } as Response);

    render(<AuditLogTable />);
  }

  it("should show loading state initially", () => {
    vi.mocked(global.fetch).mockReturnValueOnce(new Promise(() => {}));

    render(<AuditLogTable />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("should render table with entries after fetch", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getByText("auth.login")).toBeInTheDocument();
    });

    expect(screen.getByText("agent.created")).toBeInTheDocument();
    expect(screen.getByText("auth.denied")).toBeInTheDocument();
    expect(screen.getByText("user-1")).toBeInTheDocument();
    expect(screen.getByText("user-2")).toBeInTheDocument();
  });

  it("should display 'No entries found' when empty", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entries: [], total: 0, page: 1, limit: 50 }),
    } as Response);

    render(<AuditLogTable />);

    await waitFor(() => {
      expect(screen.getByText("No entries found.")).toBeInTheDocument();
    });
  });

  it("should trigger CSV download when Export CSV is clicked", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getByText("auth.login")).toBeInTheDocument();
    });

    // Mock the export fetch
    const csvContent = "id,timestamp,eventType\n1,2026-02-21,auth.login";
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => csvContent,
      headers: new Headers({
        "content-disposition": 'attachment; filename="audit-log.csv"',
      }),
    } as Response);

    // Mock URL.createObjectURL and URL.revokeObjectURL
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:http://localhost/fake");
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/audit/export");
    });

    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  it("should call verify endpoint and show green result when valid", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getByText("auth.login")).toBeInTheDocument();
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: true, checked: 3, tampered: [] }),
    } as Response);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Verify Integrity" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/audit/verify");
    });

    await waitFor(() => {
      expect(screen.getByText(/All 3 entries verified/)).toBeInTheDocument();
    });
  });

  it("should show red result when integrity check finds tampered entries", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getByText("auth.login")).toBeInTheDocument();
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: false, checked: 3, tampered: [3, 17] }),
    } as Response);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Verify Integrity" }));

    await waitFor(() => {
      expect(screen.getByText(/2 tampered entries/)).toBeInTheDocument();
    });
  });

  it("should show destructive badge for denied/failed events", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getByText("auth.denied")).toBeInTheDocument();
    });

    const deniedBadge = screen.getByText("auth.denied");
    expect(deniedBadge).toHaveAttribute("data-variant", "destructive");
  });

  it("should show secondary badge for normal events", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getByText("auth.login")).toBeInTheDocument();
    });

    const loginBadge = screen.getByText("auth.login");
    expect(loginBadge).toHaveAttribute("data-variant", "secondary");
  });

  it("should paginate with Previous and Next buttons", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: mockEntries,
        total: 120,
        page: 1,
        limit: 50,
      }),
    } as Response);

    render(<AuditLogTable />);

    await waitFor(() => {
      expect(screen.getByText("auth.login")).toBeInTheDocument();
    });

    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();

    const prevButton = screen.getByRole("button", { name: "Previous" });
    const nextButton = screen.getByRole("button", { name: "Next" });

    // Previous should be disabled on first page
    expect(prevButton).toBeDisabled();
    expect(nextButton).not.toBeDisabled();

    // Click Next
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        entries: mockEntries,
        total: 120,
        page: 2,
        limit: 50,
      }),
    } as Response);

    const user = userEvent.setup();
    await user.click(nextButton);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("page=2"));
    });
  });

  it("should have an event type filter with combobox role", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getByText("auth.login")).toBeInTheDocument();
    });

    // Verify the event type filter exists and is accessible
    const filterTrigger = screen.getByRole("combobox", {
      name: "Event Type",
    });
    expect(filterTrigger).toBeInTheDocument();

    // The default value should show "All Events"
    expect(screen.getByText("All Events")).toBeInTheDocument();
  });

  it("should open sheet with full detail when row is clicked", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getByText("auth.login")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const firstRow = screen.getByText("auth.login").closest("tr")!;
    await user.click(firstRow);

    await waitFor(() => {
      expect(screen.getByText("Entry Detail")).toBeInTheDocument();
    });

    // Full JSON detail should be visible in the sheet
    // JSON.stringify with indent puts each key on its own line in a <pre> block
    const preElement = document.querySelector("pre");
    expect(preElement).not.toBeNull();
    expect(preElement!.textContent).toContain('"email"');
    expect(preElement!.textContent).toContain("admin@example.com");
  });

  it("should fetch entries with correct URL on mount", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/audit?page=1&limit=50");
    });
  });

  it("should include from and to params in fetch URL when date range is set", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getByText("auth.login")).toBeInTheDocument();
    });

    // Mock the next fetch that will be triggered by changing the date inputs
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockAuditResponse,
    } as Response);

    const user = userEvent.setup();
    const fromInput = screen.getByLabelText("From");
    const toInput = screen.getByLabelText("To");

    // Set the "From" date
    await user.clear(fromInput);
    await user.type(fromInput, "2026-02-01");

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("from=2026-02-01"));
    });

    // Mock the next fetch for the "To" date change
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockAuditResponse,
    } as Response);

    // Set the "To" date
    await user.clear(toInput);
    await user.type(toInput, "2026-02-28");

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("to=2026-02-28"));
    });
  });

  it("should render date range inputs", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getByText("auth.login")).toBeInTheDocument();
    });

    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("To")).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("To")).toHaveAttribute("type", "date");
  });
});
