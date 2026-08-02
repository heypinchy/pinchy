// @vitest-environment jsdom
// Component tests for the Automations create/edit dialog — the one form a human
// uses to author OR change an email workflow in the UI (#139). With no workflow
// it POSTs a CreateAutomationInput to /api/automations; given a workflow it
// pre-fills and PUTs an EditAutomationInput to /api/automations/[id]. Both write
// the SAME structured object ("same object, one system"; the conversational tool
// #705 will too).
//
// The dialog GETs the agent's email-readable mailboxes (the picker options). We
// mock global.fetch (the api-client helpers read the body via text()+JSON.parse),
// so each Response exposes json() + text().
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { AgentSettingsAutomationDialog } from "@/components/agent-settings-automation-dialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const AGENT_ID = "agent-1";
const CONNECTIONS = [
  { id: "conn-a", name: "Invoices mailbox" },
  { id: "conn-b", name: "Newsletters" },
];

describe("AgentSettingsAutomationDialog", () => {
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

  /** GET connections → options; POST create → 201. Override per test as needed. */
  function mockHappyPath(connections: unknown[] = CONNECTIONS) {
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/automations/connections")) return jsonResponse(connections);
      if (url === "/api/automations" && (init as RequestInit)?.method === "POST") {
        return jsonResponse(
          { id: "wf-new", name: "x", enabled: false, status: "pending" },
          {
            status: 201,
          }
        );
      }
      return jsonResponse({});
    });
  }

  function findPost() {
    return fetchSpy.mock.calls.find(
      (c: unknown[]) =>
        String(c[0]) === "/api/automations" && (c[1] as RequestInit)?.method === "POST"
    );
  }

  function findPut(url: string) {
    return fetchSpy.mock.calls.find(
      (c: unknown[]) => String(c[0]) === url && (c[1] as RequestInit)?.method === "PUT"
    );
  }

  /** An existing workflow to seed the dialog's edit mode. Its connection is one
   *  of CONNECTIONS so the picker can pre-check it. */
  const EXISTING_WORKFLOW = {
    id: "wf-7",
    name: "File supplier invoices",
    filter: { from: ["ap@acme.com"], subjectContains: ["invoice"], hasAttachment: true },
    action: "Draft a supplier bill in Odoo.",
    enabled: false,
    status: "pending" as const,
    sweepWindowDays: 30,
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    connectionIds: ["conn-a"],
  };

  /** GET connections → options; PUT edit → 200. */
  function mockEditHappyPath(connections: unknown[] = CONNECTIONS) {
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/automations/connections")) return jsonResponse(connections);
      if (
        url === `/api/automations/${EXISTING_WORKFLOW.id}` &&
        (init as RequestInit)?.method === "PUT"
      ) {
        return jsonResponse({ id: EXISTING_WORKFLOW.id, name: "x" });
      }
      return jsonResponse({});
    });
  }

  it("loads the agent's mailboxes scoped to the agent and offers them as options", async () => {
    mockHappyPath();
    render(
      <AgentSettingsAutomationDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
    );
    expect(screen.getByRole("checkbox", { name: /Newsletters/i })).toBeInTheDocument();
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      `/api/automations/connections?agentId=${AGENT_ID}`
    );
  });

  it("POSTs a well-formed create payload and then reports success", async () => {
    mockHappyPath();
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentSettingsAutomationDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />
    );

    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
    );

    await user.type(screen.getByLabelText(/^Name/i), "File supplier invoices");
    await user.type(screen.getByLabelText(/Instruction/i), "Draft a supplier bill in Odoo.");
    await user.type(screen.getByLabelText(/^From/i), "billing@acme.com, ap@acme.com");
    await user.click(screen.getByRole("checkbox", { name: /has an attachment/i }));
    await user.type(screen.getByLabelText(/Attachment type/i), "application/pdf");
    await user.click(screen.getByRole("checkbox", { name: /Invoices mailbox/i }));

    await user.click(screen.getByRole("button", { name: /create automation/i }));

    await waitFor(() => expect(findPost()).toBeTruthy());
    const body = JSON.parse((findPost()![1] as RequestInit).body as string);
    expect(body).toEqual({
      agentId: AGENT_ID,
      name: "File supplier invoices",
      action: "Draft a supplier bill in Odoo.",
      filter: {
        from: ["billing@acme.com", "ap@acme.com"],
        hasAttachment: true,
        attachmentType: "application/pdf",
      },
      connectionIds: ["conn-a"],
      sweepWindowDays: 14,
    });

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalled();
  });

  it("omits empty filter fields — an all-blank filter posts an empty filter object", async () => {
    mockHappyPath();
    const user = userEvent.setup();
    render(
      <AgentSettingsAutomationDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
    );

    await user.type(screen.getByLabelText(/^Name/i), "Watch everything");
    await user.type(screen.getByLabelText(/Instruction/i), "Summarize each mail.");
    await user.click(screen.getByRole("checkbox", { name: /Newsletters/i }));
    await user.click(screen.getByRole("button", { name: /create automation/i }));

    await waitFor(() => expect(findPost()).toBeTruthy());
    const body = JSON.parse((findPost()![1] as RequestInit).body as string);
    expect(body.filter).toEqual({});
    expect(body.connectionIds).toEqual(["conn-b"]);
  });

  it("keeps Create disabled until name, instruction, and at least one mailbox are set", async () => {
    mockHappyPath();
    const user = userEvent.setup();
    render(
      <AgentSettingsAutomationDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
    );

    const createBtn = screen.getByRole("button", { name: /create automation/i });
    expect(createBtn).toBeDisabled();

    // Name + instruction alone is not enough — a workflow with no mailbox is
    // never dispatched (the loader inner-joins connections), so the server 400s.
    await user.type(screen.getByLabelText(/^Name/i), "No mailbox yet");
    await user.type(screen.getByLabelText(/Instruction/i), "Do a thing.");
    expect(createBtn).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /Invoices mailbox/i }));
    expect(createBtn).toBeEnabled();
  });

  it("surfaces the API error and stays open when the create fails", async () => {
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/automations/connections")) return jsonResponse(CONNECTIONS);
      if (url === "/api/automations" && (init as RequestInit)?.method === "POST") {
        return jsonResponse({ error: "The agent has no email access" }, { ok: false, status: 400 });
      }
      return jsonResponse({});
    });
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentSettingsAutomationDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
    );

    await user.type(screen.getByLabelText(/^Name/i), "Doomed");
    await user.type(screen.getByLabelText(/Instruction/i), "Try it.");
    await user.click(screen.getByRole("checkbox", { name: /Invoices mailbox/i }));
    await user.click(screen.getByRole("button", { name: /create automation/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The agent has no email access"));
    expect(onSaved).not.toHaveBeenCalled();
    // The dialog is never asked to close on failure — the user can fix and retry.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("keeps Create disabled and shows a hint when the look-back is out of range", async () => {
    mockHappyPath();
    const user = userEvent.setup();
    render(
      <AgentSettingsAutomationDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
    );

    await user.type(screen.getByLabelText(/^Name/i), "Range check");
    await user.type(screen.getByLabelText(/Instruction/i), "Do a thing.");
    await user.click(screen.getByRole("checkbox", { name: /Invoices mailbox/i }));
    const createBtn = screen.getByRole("button", { name: /create automation/i });
    expect(createBtn).toBeEnabled();

    // Above the server's 365-day cap: the form must refuse instead of letting
    // the server 400 with a raw validation message.
    const sweepInput = screen.getByLabelText(/Look back/i);
    await user.clear(sweepInput);
    await user.type(sweepInput, "9999");
    expect(createBtn).toBeDisabled();
    expect(screen.getByText(/between 1 and 365/i)).toBeInTheDocument();

    // Back in range → submittable again, hint gone.
    await user.clear(sweepInput);
    await user.type(sweepInput, "30");
    expect(createBtn).toBeEnabled();
    expect(screen.queryByText(/between 1 and 365/i)).not.toBeInTheDocument();
  });

  it("treats a blank look-back as the default sweep window", async () => {
    mockHappyPath();
    const user = userEvent.setup();
    render(
      <AgentSettingsAutomationDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
    );

    await user.type(screen.getByLabelText(/^Name/i), "Blank look-back");
    await user.type(screen.getByLabelText(/Instruction/i), "Do a thing.");
    await user.click(screen.getByRole("checkbox", { name: /Invoices mailbox/i }));
    await user.clear(screen.getByLabelText(/Look back/i));
    await user.click(screen.getByRole("button", { name: /create automation/i }));

    await waitFor(() => expect(findPost()).toBeTruthy());
    const body = JSON.parse((findPost()![1] as RequestInit).body as string);
    expect(body.sweepWindowDays).toBe(14);
  });

  it("shows a load error with retry instead of the empty-mailbox message when the fetch fails", async () => {
    let connectionCalls = 0;
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/automations/connections")) {
        connectionCalls++;
        if (connectionCalls === 1) {
          return jsonResponse({ error: "Session expired" }, { ok: false, status: 500 });
        }
        return jsonResponse(CONNECTIONS);
      }
      return jsonResponse({});
    });
    const user = userEvent.setup();
    render(
      <AgentSettingsAutomationDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    // A failed load must NOT masquerade as "this agent has no mailboxes".
    await waitFor(() => expect(screen.getByText(/Session expired/i)).toBeInTheDocument());
    expect(screen.queryByText(/no readable email connection/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
    );
  });

  it("ignores a stale connections response from a previous open", async () => {
    let resolveFirst!: (value: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => (resolveFirst = resolve));
    let connectionCalls = 0;
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/automations/connections")) {
        connectionCalls++;
        if (connectionCalls === 1) return firstResponse;
        return jsonResponse([{ id: "conn-fresh", name: "Fresh mailbox" }]);
      }
      return jsonResponse({});
    });
    const props = { agentId: AGENT_ID, onOpenChange: vi.fn(), onSaved: vi.fn() };
    const { rerender } = render(<AgentSettingsAutomationDialog {...props} open={true} />);
    // Make sure the first open's request is actually in flight before closing —
    // the load is deferred to a microtask, so closing too early would cancel it.
    await waitFor(() => expect(connectionCalls).toBe(1));

    // Close and reopen while the first request is still in flight.
    rerender(<AgentSettingsAutomationDialog {...props} open={false} />);
    rerender(<AgentSettingsAutomationDialog {...props} open={true} />);
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Fresh mailbox/i })).toBeInTheDocument()
    );

    // The first open's response lands late — it must not clobber the fresh list.
    resolveFirst(jsonResponse([{ id: "conn-stale", name: "Stale mailbox" }]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/Stale mailbox/i)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Fresh mailbox/i })).toBeInTheDocument();
  });

  // --- Edit mode: the SAME dialog, seeded with an existing workflow, PUTs the
  //     edited representation instead of POSTing a new one. Same object, one form.
  describe("edit mode", () => {
    it("prefills the form from the workflow and checks its current mailbox", async () => {
      mockEditHappyPath();
      render(
        <AgentSettingsAutomationDialog
          agentId={AGENT_ID}
          open={true}
          onOpenChange={vi.fn()}
          onSaved={vi.fn()}
          workflow={EXISTING_WORKFLOW}
        />
      );

      await waitFor(() =>
        expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
      );
      // Scalar + list filter fields come back pre-filled from the stored workflow.
      expect(screen.getByLabelText(/^Name/i)).toHaveValue("File supplier invoices");
      expect(screen.getByLabelText(/Instruction/i)).toHaveValue("Draft a supplier bill in Odoo.");
      expect(screen.getByLabelText(/^From/i)).toHaveValue("ap@acme.com");
      expect(screen.getByLabelText(/Subject contains/i)).toHaveValue("invoice");
      expect(screen.getByRole("checkbox", { name: /has an attachment/i })).toBeChecked();
      expect(screen.getByLabelText(/Look back/i)).toHaveValue(30);
      // The workflow's own mailbox is pre-selected; the other is not.
      expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /Newsletters/i })).not.toBeChecked();
      // Edit affordances, not create ones.
      expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /create automation/i })).not.toBeInTheDocument();
    });

    it("PUTs the edited representation to /api/automations/[id] and reports success", async () => {
      mockEditHappyPath();
      const onSaved = vi.fn();
      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <AgentSettingsAutomationDialog
          agentId={AGENT_ID}
          open={true}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
          workflow={EXISTING_WORKFLOW}
        />
      );
      await waitFor(() =>
        expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
      );

      // Rename, and add the second mailbox to the set.
      const nameInput = screen.getByLabelText(/^Name/i);
      await user.clear(nameInput);
      await user.type(nameInput, "File and pay invoices");
      await user.click(screen.getByRole("checkbox", { name: /Newsletters/i }));
      await user.click(screen.getByRole("button", { name: /save changes/i }));

      const url = `/api/automations/${EXISTING_WORKFLOW.id}`;
      await waitFor(() => expect(findPut(url)).toBeTruthy());
      const body = JSON.parse((findPut(url)![1] as RequestInit).body as string);
      // No agentId in the edit payload — a workflow never changes agents.
      expect(body).toEqual({
        name: "File and pay invoices",
        action: "Draft a supplier bill in Odoo.",
        filter: { from: ["ap@acme.com"], subjectContains: ["invoice"], hasAttachment: true },
        connectionIds: ["conn-a", "conn-b"],
        sweepWindowDays: 30,
      });

      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(toast.success).toHaveBeenCalled();
    });

    it("surfaces the API error and stays open when the edit fails", async () => {
      vi.mocked(global.fetch).mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith("/api/automations/connections")) return jsonResponse(CONNECTIONS);
        if (
          url === `/api/automations/${EXISTING_WORKFLOW.id}` &&
          (init as RequestInit)?.method === "PUT"
        ) {
          return jsonResponse(
            { error: "The agent has no email access" },
            { ok: false, status: 400 }
          );
        }
        return jsonResponse({});
      });
      const onSaved = vi.fn();
      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <AgentSettingsAutomationDialog
          agentId={AGENT_ID}
          open={true}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
          workflow={EXISTING_WORKFLOW}
        />
      );
      await waitFor(() =>
        expect(screen.getByRole("checkbox", { name: /Invoices mailbox/i })).toBeInTheDocument()
      );

      await user.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("The agent has no email access")
      );
      expect(onSaved).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });
  });
});
