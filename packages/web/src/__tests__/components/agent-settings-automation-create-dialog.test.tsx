// Component tests for the Automations create dialog — the form that finally
// gives a human a way to author an email workflow in the UI (#139). Until this,
// the only create path was the raw POST API; the tab could review/enable/delete
// but never create. Both this form and the conversational tool (#705) write the
// SAME object through POST /api/automations ("same object, one system").
//
// The dialog GETs the agent's email-readable mailboxes (the picker options) and
// POSTs a CreateAutomationInput. We mock global.fetch (the api-client helpers
// read the body via text()+JSON.parse), so each Response exposes json() + text().
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { AgentSettingsAutomationCreateDialog } from "@/components/agent-settings-automation-create-dialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const AGENT_ID = "agent-1";
const CONNECTIONS = [
  { id: "conn-a", name: "Invoices mailbox" },
  { id: "conn-b", name: "Newsletters" },
];

describe("AgentSettingsAutomationCreateDialog", () => {
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

  it("loads the agent's mailboxes scoped to the agent and offers them as options", async () => {
    mockHappyPath();
    render(
      <AgentSettingsAutomationCreateDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
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
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentSettingsAutomationCreateDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
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

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalled();
  });

  it("omits empty filter fields — an all-blank filter posts an empty filter object", async () => {
    mockHappyPath();
    const user = userEvent.setup();
    render(
      <AgentSettingsAutomationCreateDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
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
      <AgentSettingsAutomationCreateDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
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
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentSettingsAutomationCreateDialog
        agentId={AGENT_ID}
        open={true}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
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
    expect(onCreated).not.toHaveBeenCalled();
    // The dialog is never asked to close on failure — the user can fix and retry.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
