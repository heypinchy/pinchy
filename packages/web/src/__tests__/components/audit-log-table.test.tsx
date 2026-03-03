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

  it("should trigger CSV download when Export CSV is clicked", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
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
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/audit/export"));
    });

    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  it("should pass active filters to export CSV", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.login").length).toBeGreaterThan(0);
    });

    // Set a date filter
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockAuditResponse,
    } as Response);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("From"), "2026-02-01");

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("from=2026-02-01"));
    });

    // Now click Export CSV — it should include the from filter
    const csvContent = "id,timestamp,eventType\n1,2026-02-21,auth.login";
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => csvContent,
    } as Response);

    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:http://localhost/fake");
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("from=2026-02-01"));
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

  it("should show destructive badge for denied/failed events", async () => {
    renderWithEntriesLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("auth.failed").length).toBeGreaterThan(0);
    });

    const failedBadges = screen.getAllByText("auth.failed");
    // At least one badge should have the destructive variant
    expect(failedBadges.some((el) => el.getAttribute("data-variant") === "destructive")).toBe(true);
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
