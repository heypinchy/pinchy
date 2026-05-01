import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AuditLogTable } from "@/components/audit-log-table";

// Radix UI Select uses pointer capture and scrollIntoView which jsdom doesn't support
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

describe("AuditLogTable", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockEntries = [
    {
      id: 1,
      timestamp: "2026-02-21T10:00:00.000Z",
      actorType: "user",
      actorId: "user-1",
      actorName: "Alice Admin",
      actorDeleted: false,
      eventType: "auth.login",
      resource: null,
      resourceName: null,
      resourceDeleted: false,
      detail: { email: "admin@example.com" },
      rowHmac: "abc123",
    },
    {
      id: 2,
      timestamp: "2026-02-21T11:00:00.000Z",
      actorType: "user",
      actorId: "user-2",
      actorName: "Bob User",
      actorDeleted: false,
      eventType: "agent.created",
      resource: "agent:agent-1",
      resourceName: "Smithers",
      resourceDeleted: false,
      detail: { name: "Smithers" },
      rowHmac: "def456",
    },
    {
      id: 3,
      timestamp: "2026-02-21T12:00:00.000Z",
      actorType: "user",
      actorId: "user-3",
      actorName: null,
      actorDeleted: false,
      eventType: "auth.failed",
      resource: null,
      resourceName: null,
      resourceDeleted: false,
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

  const mockEventTypesResponse = {
    eventTypes: ["agent.created", "auth.failed", "auth.login"],
  };

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /**
   * The component makes two fetches on mount, in definition order:
   *   1. GET /api/audit/event-types  (useEffect with no deps)
   *   2. GET /api/audit?...          (useEffect depending on fetchEntries)
   */
  function mockEventTypesThenEntries(eventTypesOverride?: object, entriesOverride?: object) {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => eventTypesOverride ?? mockEventTypesResponse,
    } as Response);
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => entriesOverride ?? mockAuditResponse,
    } as Response);
  }

  function renderWithEntriesLoaded() {
    mockEventTypesThenEntries();
    render(<AuditLogTable />);
  }

  it("should show loading state initially", () => {
    // Both fetches stay pending so loading never resolves
    vi.mocked(global.fetch)
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(new Promise(() => {}));

    render(<AuditLogTable />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("should render table with entries after fetch", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      // Both mobile and desktop render event types — use getAllByText
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText("agent.created").length).toBeGreaterThan(0);
    expect(screen.getAllByText("auth.failed").length).toBeGreaterThan(0);
    // Actor names are now shown instead of raw IDs
    expect(screen.getAllByText("Alice Admin").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bob User").length).toBeGreaterThan(0);
  });

  it("should display 'No entries found' when empty", async () => {
    mockEventTypesThenEntries(undefined, { entries: [], total: 0, page: 1, limit: 50 });

    render(<AuditLogTable />);

    await waitFor(() => {
      expect(screen.getByText("No entries found.")).toBeInTheDocument();
    });
  });

  it("should trigger CSV download via Export menu → CSV", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    const csvContent = "id,timestamp,eventType\n1,2026-02-21,auth.login";
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      blob: async () => new Blob([csvContent], { type: "text/csv" }),
      headers: new Headers({
        "content-disposition": 'attachment; filename="audit-log.csv"',
      }),
    } as Response);

    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:http://localhost/fake");
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /export/i }));
    await user.click(screen.getByRole("menuitem", { name: /csv/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/audit/export"));
    });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("format=csv"));

    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  it("should trigger PDF download via Export menu → PDF", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      blob: async () =>
        new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], {
          type: "application/pdf",
        }),
      headers: new Headers({
        "content-disposition": 'attachment; filename="audit-log.pdf"',
      }),
    } as Response);

    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:http://localhost/fake");
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /export/i }));
    await user.click(screen.getByRole("menuitem", { name: /pdf/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("format=pdf"));
    });

    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  it("should pass active filters to PDF export", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockAuditResponse,
    } as Response);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("From"), "2026-02-01");

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("from=2026-02-01"));
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      blob: async () =>
        new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], {
          type: "application/pdf",
        }),
    } as Response);

    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:http://localhost/fake");
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    await user.click(screen.getByRole("button", { name: /export/i }));
    await user.click(screen.getByRole("menuitem", { name: /pdf/i }));

    await waitFor(() => {
      const calls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => c.includes("format=pdf") && c.includes("from=2026-02-01"))).toBe(
        true
      );
    });

    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  it("should call verify endpoint and show green result when valid", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: true, totalChecked: 3, invalidIds: [] }),
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
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: false, totalChecked: 3, invalidIds: [3, 17] }),
    } as Response);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Verify Integrity" }));

    await waitFor(() => {
      expect(screen.getByText(/2 tampered entries/)).toBeInTheDocument();
    });
  });

  it("should show secondary badge for all event types including deleted/failed", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.failed").length).toBeGreaterThan(0);
    });

    const failedBadges = screen.getAllByText("auth.failed");
    // All event type badges should use secondary variant — no destructive styling
    expect(failedBadges.every((el) => el.getAttribute("data-variant") === "secondary")).toBe(true);
  });

  it("should show secondary badge for normal events", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    const loginBadges = screen.getAllByText("auth.login");
    // At least one badge should have the secondary variant
    expect(loginBadges.some((el) => el.getAttribute("data-variant") === "secondary")).toBe(true);
  });

  it("should paginate with Previous and Next buttons", async () => {
    mockEventTypesThenEntries(undefined, {
      entries: mockEntries,
      total: 120,
      page: 1,
      limit: 50,
    });

    render(<AuditLogTable />);

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
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
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    // Verify the event type filter exists and is accessible
    const filterTrigger = screen.getByRole("combobox", {
      name: "Event Type",
    });
    expect(filterTrigger).toBeInTheDocument();

    // The default value should show "All Events"
    expect(screen.getByText("All Events")).toBeInTheDocument();
  });

  it("should fetch event types from API on mount to populate dropdown", async () => {
    mockEventTypesThenEntries({ eventTypes: ["tool.bash", "tool.read", "agent.deleted"] });
    render(<AuditLogTable />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/audit/event-types");
    });
  });

  it("should open sheet with full detail when row is clicked", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    const user = userEvent.setup();
    // Click the first clickable container (mobile card or table row) that contains auth.login
    const allLoginElements = screen.getAllByText("auth.login");
    // Find the first one that has a clickable ancestor (tr or div with rounded border)
    const clickableRow =
      allLoginElements[0].closest("tr") ?? allLoginElements[0].closest("div.rounded");
    await user.click(clickableRow!);

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
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
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
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("To")).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("To")).toHaveAttribute("type", "date");
  });

  it("should show 'deactivated' badge for deleted actor", async () => {
    const entriesWithDeletedActor = [
      {
        id: 10,
        timestamp: "2026-02-21T10:00:00.000Z",
        actorType: "user",
        actorId: "user-deleted-1",
        actorName: "Alice",
        actorDeleted: true,
        eventType: "auth.login",
        resource: null,
        resourceName: null,
        resourceDeleted: false,
        detail: {},
        rowHmac: "hmac-deleted",
      },
    ];

    mockEventTypesThenEntries(undefined, {
      entries: entriesWithDeletedActor,
      total: 1,
      page: 1,
      limit: 50,
    });

    render(<AuditLogTable />);

    await waitFor(() => {
      expect(screen.getAllByText("deactivated").length).toBeGreaterThan(0);
    });
  });

  it("should show 'deleted' badge for deleted resource", async () => {
    const entriesWithDeletedResource = [
      {
        id: 11,
        timestamp: "2026-02-21T10:00:00.000Z",
        actorType: "user",
        actorId: "user-1",
        actorName: "Alice Admin",
        actorDeleted: false,
        eventType: "agent.deleted",
        resource: "agent:some-id",
        resourceName: "Old Agent",
        resourceDeleted: true,
        detail: {},
        rowHmac: "hmac-res-deleted",
      },
    ];

    mockEventTypesThenEntries(undefined, {
      entries: entriesWithDeletedResource,
      total: 1,
      page: 1,
      limit: 50,
    });

    render(<AuditLogTable />);

    await waitFor(() => {
      expect(screen.getAllByText("deleted").length).toBeGreaterThan(0);
    });
  });

  it("should open detail sheet when Enter is pressed on a focused table row", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    // Desktop TableRow should have tabIndex=0 for keyboard accessibility
    const rows = screen.getAllByRole("row");
    // rows[0] is the header; rows[1] is the first data row
    const firstDataRow = rows[1];
    fireEvent.keyUp(firstDataRow, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("Entry Detail")).toBeInTheDocument();
    });
  });

  it("should render JSON detail with syntax highlighting tokens", async () => {
    const user = userEvent.setup();
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    const allLoginElements = screen.getAllByText("auth.login");
    const clickableRow =
      allLoginElements[0].closest("tr") ?? allLoginElements[0].closest("div.rounded");
    await user.click(clickableRow!);

    await waitFor(() => {
      expect(screen.getByText("Entry Detail")).toBeInTheDocument();
    });

    // Prism.highlight produces <span class="token ..."> inside the code element
    const codeElement = document.querySelector(".json-highlight code");
    expect(codeElement).not.toBeNull();
    expect(codeElement!.innerHTML).toContain('class="token');
  });

  it("should highlight tampered rows with data attribute after integrity check", async () => {
    renderWithEntriesLoaded(); // mockEntries have ids 1, 2, 3

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: false, totalChecked: 3, invalidIds: [1, 3] }),
    } as Response);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Verify Integrity" }));

    await waitFor(() => {
      expect(screen.getByText(/2 tampered entries/)).toBeInTheDocument();
    });

    // Desktop table rows: row 0 is header, rows 1-3 are data rows
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveAttribute("data-tampered", "true"); // id:1 — tampered
    expect(rows[2]).not.toHaveAttribute("data-tampered"); // id:2 — clean
    expect(rows[3]).toHaveAttribute("data-tampered", "true"); // id:3 — tampered
  });

  it("should show 'highlighted in table' message instead of listing tampered IDs", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: false, totalChecked: 3, invalidIds: [1, 3] }),
    } as Response);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Verify Integrity" }));

    await waitFor(() => {
      expect(screen.getByText(/2 tampered entries/)).toBeInTheDocument();
    });

    // Should NOT show raw ID list
    expect(screen.queryByText(/IDs:/)).not.toBeInTheDocument();
    // Should direct user to the table
    expect(screen.getByText(/highlighted/i)).toBeInTheDocument();
  });

  it("should disable verify button and show loading text while verifying", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    // Keep the verify fetch pending indefinitely
    vi.mocked(global.fetch).mockReturnValueOnce(new Promise(() => {}));

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Verify Integrity" }));

    // Button should be disabled and show loading text
    expect(screen.getByRole("button", { name: "Verifying…" })).toBeDisabled();
  });

  it("should clear result banner and row highlighting when dismiss is clicked", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: false, totalChecked: 3, invalidIds: [1, 3] }),
    } as Response);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Verify Integrity" }));

    await waitFor(() => {
      expect(screen.getByText(/2 tampered entries/)).toBeInTheDocument();
    });

    // Row highlighting should be active
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveAttribute("data-tampered", "true");

    // Click dismiss
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    // Banner should be gone
    expect(screen.queryByText(/2 tampered entries/)).not.toBeInTheDocument();
    // Row highlighting should be cleared
    expect(rows[1]).not.toHaveAttribute("data-tampered");
  });

  const v2SuccessEntry = {
    id: 101,
    timestamp: "2026-02-21T10:00:00.000Z",
    actorType: "user",
    actorId: "user-1",
    actorName: "Alice Admin",
    actorDeleted: false,
    eventType: "tool.bash",
    resource: null,
    resourceName: null,
    resourceDeleted: false,
    detail: { cmd: "ls" },
    rowHmac: "hmac-v2-success",
    version: 2,
    outcome: "success" as const,
    error: null,
  };

  const v2FailureEntry = {
    id: 102,
    timestamp: "2026-02-21T11:00:00.000Z",
    actorType: "user",
    actorId: "user-1",
    actorName: "Alice Admin",
    actorDeleted: false,
    eventType: "tool.bash",
    resource: null,
    resourceName: null,
    resourceDeleted: false,
    detail: { cmd: "rm -rf /" },
    rowHmac: "hmac-v2-failure",
    version: 2,
    outcome: "failure" as const,
    error: { message: "Permission denied: sandbox blocked" },
  };

  const v1LegacyEntry = {
    id: 103,
    timestamp: "2026-02-21T12:00:00.000Z",
    actorType: "user",
    actorId: "user-1",
    actorName: "Alice Admin",
    actorDeleted: false,
    eventType: "auth.login",
    resource: null,
    resourceName: null,
    resourceDeleted: false,
    detail: {},
    rowHmac: "hmac-v1",
    version: 1,
    outcome: null,
    error: null,
  };

  it("shows a green check icon for v2 success entries", async () => {
    mockEventTypesThenEntries(undefined, {
      entries: [v2SuccessEntry],
      total: 1,
      page: 1,
      limit: 50,
    });
    render(<AuditLogTable />);
    await waitFor(() => {
      expect(screen.getAllByLabelText("Success").length).toBeGreaterThan(0);
    });
  });

  it("shows a red X icon for v2 failure entries", async () => {
    mockEventTypesThenEntries(undefined, {
      entries: [v2FailureEntry],
      total: 1,
      page: 1,
      limit: 50,
    });
    render(<AuditLogTable />);
    await waitFor(() => {
      expect(screen.getAllByLabelText("Failure").length).toBeGreaterThan(0);
    });
  });

  it("shows a neutral 'Not tracked' indicator for v1 legacy entries", async () => {
    mockEventTypesThenEntries(undefined, {
      entries: [v1LegacyEntry],
      total: 1,
      page: 1,
      limit: 50,
    });
    render(<AuditLogTable />);
    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByLabelText("Not tracked").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Success")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Failure")).not.toBeInTheDocument();
  });

  it("renders a status filter Select with All/Success/Failures options", async () => {
    renderWithEntriesLoaded();
    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "All Statuses" })).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "Success only" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Failures only" })).toBeInTheDocument();
  });

  it("adds status=failure to the API request when 'Failures only' is selected", async () => {
    renderWithEntriesLoaded();
    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockAuditResponse,
    } as Response);

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Failures only" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("status=failure"));
    });
  });

  it("renders a prominent error block in the detail sheet for failure entries", async () => {
    mockEventTypesThenEntries(undefined, {
      entries: [v2FailureEntry],
      total: 1,
      page: 1,
      limit: 50,
    });
    render(<AuditLogTable />);

    await waitFor(() => {
      expect(screen.getAllByText("tool.bash").length).toBeGreaterThan(0);
    });

    const user = userEvent.setup();
    const el = screen.getAllByText("tool.bash")[0];
    const clickable = el.closest("tr") ?? el.closest("div.rounded");
    await user.click(clickable!);

    await waitFor(() => {
      expect(screen.getByText("Entry Detail")).toBeInTheDocument();
    });

    const errorMsg = screen.getByText("Permission denied: sandbox blocked");
    expect(errorMsg).toBeInTheDocument();

    // Ensure error block appears before the Detail JSON block (DOM order)
    const detailLabel = screen.getByText("Detail");
    const position = errorMsg.compareDocumentPosition(detailLabel);
    // DOCUMENT_POSITION_FOLLOWING = 4 → detailLabel comes AFTER errorMsg
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("should show truncated actorId when actorName is null", async () => {
    const entriesWithNullName = [
      {
        id: 12,
        timestamp: "2026-02-21T10:00:00.000Z",
        actorType: "user",
        actorId: "user-abc-123",
        actorName: null,
        actorDeleted: false,
        eventType: "auth.login",
        resource: null,
        resourceName: null,
        resourceDeleted: false,
        detail: {},
        rowHmac: "hmac-null-name",
      },
    ];

    mockEventTypesThenEntries(undefined, {
      entries: entriesWithNullName,
      total: 1,
      page: 1,
      limit: 50,
    });

    render(<AuditLogTable />);

    // actorId.slice(0, 8) = "user-abc", displayed as "user-abc…"
    await waitFor(() => {
      expect(screen.getAllByText("user-abc…").length).toBeGreaterThan(0);
    });
  });
});
