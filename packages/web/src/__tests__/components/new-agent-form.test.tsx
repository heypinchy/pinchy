import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { NewAgentForm } from "@/components/new-agent-form";

const { mockPush, mockReplace, mockSearchParams } = vi.hoisted(() => {
  const searchParamsRef = { current: new URLSearchParams() };

  const push = vi.fn((url: string) => {
    const u = new URL(url, "http://localhost");
    searchParamsRef.current = u.searchParams;
  });

  const replace = vi.fn((url: string) => {
    const u = new URL(url, "http://localhost");
    searchParamsRef.current = u.searchParams;
  });

  return { mockPush: push, mockReplace: replace, mockSearchParams: searchParamsRef };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    back: vi.fn(),
    refresh: vi.fn(),
    replace: mockReplace,
  }),
  useSearchParams: () => mockSearchParams.current,
}));

const mockTemplates = [
  {
    id: "knowledge-base",
    name: "Knowledge Base",
    description: "Answer questions from documents",
    requiresDirectories: true,
    defaultTagline: "Answer questions from your docs",
  },
  {
    id: "custom",
    name: "Custom Agent",
    description: "Full flexibility",
    requiresDirectories: false,
    defaultTagline: null,
  },
];

describe("NewAgentForm — name max length", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSearchParams.current = new URLSearchParams();
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: mockTemplates }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should have maxLength attribute on name input", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText(/start from scratch/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/start from scratch/i));

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toHaveAttribute("maxLength", "30");
    });
  });
});

describe("NewAgentForm — cancel button", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSearchParams.current = new URLSearchParams();
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: mockTemplates }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns to template selection instead of navigating away", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText(/start from scratch/i)).toBeInTheDocument();
    });

    // Select a template to get to the form
    await userEvent.click(screen.getByText(/start from scratch/i));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    // Click Cancel
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    // Should show the template selector again, not navigate away
    await waitFor(() => {
      expect(screen.getByText(/start from scratch/i)).toBeInTheDocument();
      expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    });

    // The form should no longer be visible
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
  });
});

describe("NewAgentForm — URL history", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
    mockSearchParams.current = new URLSearchParams();

    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: mockTemplates }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("uses router.push (not replace) when selecting a template so browser Back works", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText(/start from scratch/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/start from scratch/i));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("template=custom"));
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("returns to template selector when searchParams lose the template parameter (browser Back)", async () => {
    // Start with template=custom in URL (simulating deep link or after selection)
    mockSearchParams.current = new URLSearchParams("template=custom");

    const { rerender } = render(<NewAgentForm />);

    await waitFor(() => {
      // Form should be visible because template is selected
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    // Simulate browser Back: searchParams no longer has template
    mockSearchParams.current = new URLSearchParams();
    rerender(<NewAgentForm />);

    await waitFor(() => {
      // Should show template selector again
      expect(screen.getByText(/start from scratch/i)).toBeInTheDocument();
      expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    });

    // Form should be gone
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
  });
});

describe("NewAgentForm — tagline field", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSearchParams.current = new URLSearchParams();
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: mockTemplates }),
        } as Response;
      }
      if (String(url) === "/api/data-directories") {
        return {
          ok: true,
          json: async () => ({ directories: [] }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows tagline field pre-filled from template when template is selected", async () => {
    render(<NewAgentForm />);

    // Wait for templates to load
    await waitFor(() => {
      expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    });

    // Select the knowledge-base template
    await userEvent.click(screen.getByText("Knowledge Base"));

    // The tagline field should be visible and pre-filled
    await waitFor(() => {
      expect(screen.getByLabelText(/tagline/i)).toHaveValue("Answer questions from your docs");
    });
  });

  it("pre-fills tagline from template when page is loaded with ?template= in URL (reload scenario)", async () => {
    // Simulate a page reload with template already in URL: templates load AFTER initial render,
    // so selectedTemplate is set but selectedTemplateObj is undefined on first effect run.
    mockSearchParams.current = new URLSearchParams("template=knowledge-base");

    render(<NewAgentForm />);

    // Tagline should be pre-filled from static template data (no API wait needed)
    await waitFor(() => {
      expect(screen.getByLabelText(/tagline/i)).toHaveValue("Answer questions from your docs");
    });

    // Flush remaining async effects (name prefill + fetchDirectories) so they
    // complete before the mock is torn down in afterEach.
    await act(async () => {});
  });

  it("shows empty tagline field when template has null defaultTagline", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText(/start from scratch/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/start from scratch/i));

    await waitFor(() => {
      expect(screen.getByLabelText(/tagline/i)).toHaveValue("");
    });
  });

  it("auto-selects email connection and includes connectionId in POST for email templates", async () => {
    const emailTemplates = [
      ...mockTemplates,
      {
        id: "email-assistant",
        name: "Email Assistant",
        description: "Read, search, and draft emails",
        requiresDirectories: false,
        requiresEmailConnection: true,
        defaultTagline: "Read, search, and draft emails from your Gmail inbox",
      },
    ];

    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: emailTemplates }),
        } as Response;
      }
      if (String(url) === "/api/integrations") {
        return {
          ok: true,
          json: async () => [{ id: "email-conn-1", name: "Gmail Work", type: "google" }],
        } as Response;
      }
      if (String(url) === "/api/agents" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ id: "new-agent-id" }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });

    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText("Email Assistant")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Email Assistant"));

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText(/name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Hermes");

    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        ([u, i]) => String(u) === "/api/agents" && i?.method === "POST"
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1]!.body as string);
      expect(body.connectionId).toBe("email-conn-1");
      expect(body.templateId).toBe("email-assistant");
    });
  });

  it("includes tagline in POST body on submit", async () => {
    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: mockTemplates }),
        } as Response;
      }
      if (String(url) === "/api/agents" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ id: "new-agent-id" }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });

    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText(/start from scratch/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/start from scratch/i));

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText(/name/i);
    await userEvent.type(nameInput, "My Bot");

    const taglineInput = screen.getByLabelText(/tagline/i);
    await userEvent.clear(taglineInput);
    await userEvent.type(taglineInput, "My custom tagline");

    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        ([u, i]) => String(u) === "/api/agents" && i?.method === "POST"
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1]!.body as string);
      expect(body.tagline).toBe("My custom tagline");
    });
  });
});

describe("NewAgentForm — intro text", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSearchParams.current = new URLSearchParams();
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: mockTemplates }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows subtitle under Create New Agent heading", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText(/Pick a template to get started/)).toBeInTheDocument();
    });
  });
});

describe("NewAgentForm — tagline helper", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSearchParams.current = new URLSearchParams();
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: mockTemplates }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows helper text below tagline field", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText(/start from scratch/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/start from scratch/i));

    await waitFor(() => {
      expect(screen.getByText(/Shown below the agent name/)).toBeInTheDocument();
    });
  });
});

describe("NewAgentForm — permission preview", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const odooTemplates = [
    ...mockTemplates,
    {
      id: "odoo-crm-assistant",
      name: "CRM Assistant",
      description: "Manage leads",
      requiresDirectories: false,
      requiresOdooConnection: true,
      odooAccessLevel: "read-write",
      defaultTagline: "Manage leads",
    },
  ];

  beforeEach(() => {
    mockSearchParams.current = new URLSearchParams();
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: odooTemplates }),
        } as Response;
      }
      if (String(url) === "/api/data-directories") {
        return {
          ok: true,
          json: async () => ({ directories: [] }),
        } as Response;
      }
      if (String(url) === "/api/integrations") {
        return {
          ok: true,
          json: async () => [{ id: "conn-1", name: "My Odoo", type: "odoo", data: {} }],
        } as Response;
      }
      if (String(url) === "/api/agents") {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows read-only preview for documents template", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Knowledge Base"));

    await waitFor(() => {
      expect(screen.getByText("What this agent can do")).toBeInTheDocument();
      expect(screen.getByText("Read files in the selected directories")).toBeInTheDocument();
      expect(screen.getByText("Cannot modify or delete files")).toBeInTheDocument();
    });
  });

  it("shows read-write preview for Odoo read-write template", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText("CRM Assistant")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("CRM Assistant"));

    await waitFor(() => {
      expect(screen.getByText("What this agent can do")).toBeInTheDocument();
      expect(screen.getByText("Read and write data in Odoo")).toBeInTheDocument();
      expect(screen.getByText("This agent can modify data in Odoo")).toBeInTheDocument();
    });
  });

  it("does not show preview for custom template", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText(/start from scratch/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/start from scratch/i));

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    expect(screen.queryByText("What this agent can do")).not.toBeInTheDocument();
  });

  it("shows 'adjust permissions after creation' note", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Knowledge Base"));

    await waitFor(() => {
      expect(screen.getByText(/adjust permissions after creation/)).toBeInTheDocument();
    });
  });
});

describe("NewAgentForm — no connections link", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const odooTemplates = [
    ...mockTemplates,
    {
      id: "odoo-sales-analyst",
      name: "Sales Analyst",
      description: "Analyze revenue",
      requiresDirectories: false,
      requiresOdooConnection: true,
      odooAccessLevel: "read-only",
      defaultTagline: "Analyze revenue",
    },
  ];

  beforeEach(() => {
    mockSearchParams.current = new URLSearchParams();
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: odooTemplates }),
        } as Response;
      }
      if (String(url) === "/api/integrations") {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      if (String(url) === "/api/agents") {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows setup link when no Odoo connections available", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText("Sales Analyst")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Sales Analyst"));

    await waitFor(() => {
      expect(screen.getByText(/No Odoo connections yet/)).toBeInTheDocument();
    });

    const link = screen.getByText(/Set up connection/);
    expect(link).toBeInTheDocument();
    expect(link.closest("a")).toHaveAttribute("href", "/settings?tab=integrations");
  });
});

describe("NewAgentForm — suggested name", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSearchParams.current = new URLSearchParams();
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: mockTemplates }),
        } as Response;
      }
      if (String(url) === "/api/agents") {
        return {
          ok: true,
          json: async () => [{ name: "Ada" }],
        } as Response;
      }
      if (String(url) === "/api/data-directories") {
        return {
          ok: true,
          json: async () => ({ directories: [] }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("pre-fills the name field with a suggested name when selecting a template", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Knowledge Base"));

    await waitFor(() => {
      const nameInput = screen.getByLabelText(/name/i) as HTMLInputElement;
      expect(nameInput.value).not.toBe("");
    });
  });

  it("does not pre-fill name for custom template", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText(/start from scratch/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/start from scratch/i));

    await waitFor(() => {
      const nameInput = screen.getByLabelText(/name/i) as HTMLInputElement;
      expect(nameInput.value).toBe("");
    });
  });

  it("fetches existing agent names to avoid duplicates", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Knowledge Base"));

    await waitFor(() => {
      const fetchCalls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(fetchCalls.some((url) => url === "/api/agents")).toBe(true);
    });
  });

  it("auto-focuses the name field after selecting a template", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Knowledge Base"));

    await waitFor(() => {
      const nameInput = screen.getByLabelText(/name/i);
      expect(nameInput).toHaveFocus();
    });
  });

  it("selects all text in the name field so users can overtype", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Knowledge Base"));

    await waitFor(() => {
      const nameInput = screen.getByLabelText(/name/i) as HTMLInputElement;
      expect(nameInput.value.length).toBeGreaterThan(0);
      expect(nameInput.selectionStart).toBe(0);
      expect(nameInput.selectionEnd).toBe(nameInput.value.length);
    });
  });
});

describe("NewAgentForm — optional Odoo models do not block creation", () => {
  // End-to-end guard that the `optional: true` flag on a template's
  // requiredModels is honored by the UI gate. The Approval Manager template
  // lists `approval.request` and `approval.category` (Odoo Enterprise's
  // Approvals module) as optional, so a Community connection that lacks
  // those models must still allow agent creation.
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const approvalManagerInList = [
    ...mockTemplates,
    {
      id: "odoo-approval-manager",
      name: "Approval Manager",
      description:
        "Review and approve expenses, leaves, purchases — with policy checks and clear escalation",
      requiresDirectories: false,
      requiresOdooConnection: true,
      odooAccessLevel: "read-write",
      defaultTagline:
        "Review and approve expenses, leaves, purchases — with policy checks and clear escalation",
    },
  ];

  // Connection lists every non-optional model required by Approval Manager,
  // but deliberately omits `approval.request` and `approval.category` (the
  // two optional, Enterprise-only ones).
  const communityConnectionModels = [
    { model: "hr.expense.sheet", name: "Expense Reports", access: rwAccess() },
    { model: "hr.expense", name: "Expenses", access: readAccess() },
    { model: "hr.leave", name: "Time Off", access: rwAccess() },
    { model: "purchase.order", name: "Purchase Order", access: rwAccess() },
    { model: "hr.employee", name: "Employee", access: readAccess() },
    { model: "res.partner", name: "Contact", access: readAccess() },
    { model: "mail.activity", name: "Activity", access: fullAccess() },
    { model: "mail.message", name: "Message", access: { ...readAccess(), create: true } },
  ];

  function readAccess() {
    return { read: true, create: false, write: false, delete: false };
  }
  function rwAccess() {
    return { read: true, create: false, write: true, delete: false };
  }
  function fullAccess() {
    return { read: true, create: true, write: true, delete: false };
  }

  beforeEach(() => {
    mockSearchParams.current = new URLSearchParams();
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/templates") {
        return {
          ok: true,
          json: async () => ({ templates: approvalManagerInList }),
        } as Response;
      }
      if (String(url) === "/api/data-directories") {
        return { ok: true, json: async () => ({ directories: [] }) } as Response;
      }
      if (String(url) === "/api/integrations") {
        return {
          ok: true,
          json: async () => [
            {
              id: "conn-community",
              name: "Odoo Community",
              type: "odoo",
              data: { models: communityConnectionModels },
            },
          ],
        } as Response;
      }
      if (String(url) === "/api/agents") {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("keeps the Create button enabled when only optional models are missing", async () => {
    render(<NewAgentForm />);

    await waitFor(() => {
      expect(screen.getByText("Approval Manager")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Approval Manager"));

    // The single connection auto-selects, which triggers validation. We wait
    // for the form view (Cancel button confirms we're past template selection)
    // and then assert the Create button is interactable.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    const createButton = await screen.findByRole("button", { name: /create/i });
    await waitFor(() => {
      expect(createButton).not.toBeDisabled();
    });

    // The "Missing Odoo modules" alert must NOT appear — optional misses are
    // not gating, and the alert is only for blocking (non-optional) misses.
    expect(screen.queryByText(/Missing Odoo modules/i)).not.toBeInTheDocument();
  });
});
