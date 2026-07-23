// Component tests for the Automations tab — the "review & activate" surface for
// Inbox Agent email workflows (#139). A workflow is created pending+disabled
// (write API #864); the sweep dispatches only ENABLED workflows, so this tab is
// where a human reviews the structured translation and flips it on — the
// human-gated step "propose, don't self-activate" reserves for a person.
//
// The tab drives the management API (#873): GET /api/automations?agentId,
// PATCH /api/automations/[id] {enabled}, DELETE /api/automations/[id]. We mock
// global.fetch (the api-client helpers read the body via text()+JSON.parse), so
// each Response mock exposes BOTH json() and text().
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { AgentSettingsAutomations } from "@/components/agent-settings-automations";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const AGENT_ID = "agent-1";

const mockAutomations = [
  {
    id: "wf-1",
    name: "File supplier invoices",
    filter: { hasAttachment: true, from: ["billing@acme.com"] },
    action: "Draft a supplier bill in Odoo.",
    enabled: false,
    status: "pending",
    sweepWindowDays: 14,
    createdBy: "u1",
    createdAt: "2026-07-20T10:00:00.000Z",
    connectionIds: ["conn-a"],
  },
  {
    id: "wf-2",
    name: "Summarize newsletters",
    filter: {},
    action: "Post a one-line summary.",
    enabled: true,
    status: "active",
    sweepWindowDays: 7,
    createdBy: "u1",
    createdAt: "2026-07-21T10:00:00.000Z",
    connectionIds: ["conn-a", "conn-b"],
  },
];

describe("AgentSettingsAutomations", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
    const text = JSON.stringify(body);
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => text,
    } as unknown as Response;
  }

  /** Route GET /api/automations to `list`; everything else (PATCH/DELETE) to ok. */
  function mockList(list: unknown[] = mockAutomations) {
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/automations?")) return jsonResponse(list);
      // PATCH/DELETE on /api/automations/<id>
      return jsonResponse({ ok: true });
    });
  }

  it("lists the agent's workflows with filter summary, action, status and mailbox count", async () => {
    mockList();
    render(<AgentSettingsAutomations agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText("File supplier invoices")).toBeInTheDocument();
    });

    // It fetches scoped to this agent.
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`/api/automations?agentId=${AGENT_ID}`);

    const row1 = screen.getByRole("row", { name: /File supplier invoices/ });
    const cells1 = within(row1);
    expect(cells1.getByText("Draft a supplier bill in Odoo.")).toBeInTheDocument();
    // A pending workflow shows a status badge.
    expect(cells1.getByText(/pending/i)).toBeInTheDocument();
    // Filter is rendered human-readable, not raw JSON.
    expect(cells1.getByText(/has an attachment/i)).toBeInTheDocument();
    expect(cells1.getByText(/billing@acme\.com/i)).toBeInTheDocument();
    // One mailbox attached.
    expect(cells1.getByText(/1 mailbox/i)).toBeInTheDocument();

    const row2 = screen.getByRole("row", { name: /Summarize newsletters/ });
    const cells2 = within(row2);
    expect(cells2.getByText(/active/i)).toBeInTheDocument();
    // An empty filter watches the whole mailbox.
    expect(cells2.getByText(/entire mailbox/i)).toBeInTheDocument();
    expect(cells2.getByText(/2 mailboxes/i)).toBeInTheDocument();
  });

  it("shows an empty state when the agent has no workflows", async () => {
    mockList([]);
    render(<AgentSettingsAutomations agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/no automations yet/i)).toBeInTheDocument();
    });
  });

  it("enables a pending workflow via PATCH and flips its toggle", async () => {
    mockList();
    const user = userEvent.setup();
    render(<AgentSettingsAutomations agentId={AGENT_ID} />);

    await waitFor(() => expect(screen.getByText("File supplier invoices")).toBeInTheDocument());

    const row1 = screen.getByRole("row", { name: /File supplier invoices/ });
    await user.click(within(row1).getByRole("button", { name: /enable/i }));

    await waitFor(() => {
      const patch = fetchSpy.mock.calls.find(
        (c: unknown[]) =>
          String(c[0]) === "/api/automations/wf-1" && (c[1] as RequestInit)?.method === "PATCH"
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({ enabled: true });
    });

    // The toggle now offers to disable it (optimistic flip).
    await waitFor(() => {
      const r = screen.getByRole("row", { name: /File supplier invoices/ });
      expect(within(r).getByRole("button", { name: /disable/i })).toBeInTheDocument();
    });
  });

  it("disables an enabled workflow via PATCH { enabled: false }", async () => {
    mockList();
    const user = userEvent.setup();
    render(<AgentSettingsAutomations agentId={AGENT_ID} />);

    await waitFor(() => expect(screen.getByText("Summarize newsletters")).toBeInTheDocument());

    const row2 = screen.getByRole("row", { name: /Summarize newsletters/ });
    await user.click(within(row2).getByRole("button", { name: /disable/i }));

    await waitFor(() => {
      const patch = fetchSpy.mock.calls.find(
        (c: unknown[]) =>
          String(c[0]) === "/api/automations/wf-2" && (c[1] as RequestInit)?.method === "PATCH"
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({ enabled: false });
    });
  });

  it("surfaces a toast when the toggle fails and does not flip the button", async () => {
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/automations?")) return jsonResponse(mockAutomations);
      return jsonResponse({ error: "Boom" }, { ok: false, status: 500 });
    });
    const user = userEvent.setup();
    render(<AgentSettingsAutomations agentId={AGENT_ID} />);

    await waitFor(() => expect(screen.getByText("File supplier invoices")).toBeInTheDocument());
    const row1 = screen.getByRole("row", { name: /File supplier invoices/ });
    await user.click(within(row1).getByRole("button", { name: /enable/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Boom"));
    // Still offers to enable — the optimistic flip was rolled back.
    expect(
      within(screen.getByRole("row", { name: /File supplier invoices/ })).getByRole("button", {
        name: /enable/i,
      })
    ).toBeInTheDocument();
  });

  it("deletes a workflow after confirmation and removes its row", async () => {
    mockList();
    const user = userEvent.setup();
    render(<AgentSettingsAutomations agentId={AGENT_ID} />);

    await waitFor(() => expect(screen.getByText("Summarize newsletters")).toBeInTheDocument());

    const row2 = screen.getByRole("row", { name: /Summarize newsletters/ });
    await user.click(within(row2).getByRole("button", { name: /delete/i }));

    // Confirm in the dialog.
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /delete/i }));

    await waitFor(() => {
      const del = fetchSpy.mock.calls.find(
        (c: unknown[]) =>
          String(c[0]) === "/api/automations/wf-2" && (c[1] as RequestInit)?.method === "DELETE"
      );
      expect(del).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.queryByText("Summarize newsletters")).not.toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it("opens the create dialog and reloads the list after a workflow is created", async () => {
    let listCalls = 0;
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit)?.method ?? "GET";
      if (url.startsWith("/api/automations/connections")) {
        return jsonResponse([{ id: "conn-a", name: "Invoices mailbox" }]);
      }
      if (url.startsWith("/api/automations?")) {
        listCalls++;
        return jsonResponse(mockAutomations);
      }
      if (url === "/api/automations" && method === "POST") {
        return jsonResponse(
          { id: "wf-new", name: "New one", enabled: false, status: "pending" },
          { status: 201 }
        );
      }
      return jsonResponse({ ok: true });
    });

    const user = userEvent.setup();
    render(<AgentSettingsAutomations agentId={AGENT_ID} />);
    await waitFor(() => expect(screen.getByText("File supplier invoices")).toBeInTheDocument());
    const listCallsAfterLoad = listCalls;

    await user.click(screen.getByRole("button", { name: /new automation/i }));

    // Dialog opened → mailbox picker populated from the connections endpoint.
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
    );

    await user.type(screen.getByLabelText(/^Name/i), "New one");
    await user.type(screen.getByLabelText(/Instruction/i), "Do it.");
    await user.click(screen.getByRole("checkbox", { name: /Invoices mailbox/i }));
    await user.click(screen.getByRole("button", { name: /create automation/i }));

    // onCreated → load(): the list is re-fetched after a successful create.
    await waitFor(() => expect(listCalls).toBeGreaterThan(listCallsAfterLoad));
  });
});
