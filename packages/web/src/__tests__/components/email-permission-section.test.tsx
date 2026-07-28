// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { EmailPermissionSection } from "@/components/email-permission-section";

// Mock fetch — only used for /api/agents/:id/integrations (per-agent permissions)
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeEmailConnection(id: string, name: string, type: "google" | "microsoft" = "google") {
  return { id, name, type, status: "active" as const, data: null };
}

function mockAgentPerms(agentPerms: unknown[] = []) {
  mockFetch.mockImplementation((url: string) => {
    if (url.match(/\/api\/agents\/.*\/integrations/)) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(agentPerms),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe("EmailPermissionSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders connection selector with provided email connections", async () => {
    mockAgentPerms();
    const onChange = vi.fn();

    render(
      <EmailPermissionSection
        agentId="agent-1"
        connections={[
          makeEmailConnection("email-1", "Gmail Work", "google"),
          makeEmailConnection("email-2", "Outlook", "microsoft"),
        ]}
        onChange={onChange}
      />
    );
    await waitFor(() => {
      expect(screen.getByText("Connection")).toBeInTheDocument();
    });
  });

  it("displays 'Email' as model name instead of technical model id", async () => {
    mockAgentPerms([
      {
        connectionId: "email-1",
        connectionName: "Gmail Work",
        connectionType: "google",
        permissions: [{ model: "email", modelName: "Email", operation: "read" }],
      },
    ]);
    const onChange = vi.fn();

    render(
      <EmailPermissionSection
        agentId="agent-1"
        connections={[makeEmailConnection("email-1", "Gmail Work", "google")]}
        onChange={onChange}
      />
    );
    await waitFor(() => {
      expect(screen.getByText("Email")).toBeInTheDocument();
    });
  });

  it("shows email-specific operation column headers", async () => {
    mockAgentPerms([
      {
        connectionId: "email-1",
        connectionName: "Gmail Work",
        connectionType: "google",
        permissions: [{ model: "email", modelName: "Email", operation: "read" }],
      },
    ]);
    const onChange = vi.fn();

    render(
      <EmailPermissionSection
        agentId="agent-1"
        connections={[makeEmailConnection("email-1", "Gmail Work", "google")]}
        onChange={onChange}
      />
    );
    await waitFor(() => {
      expect(screen.getByText("Read messages")).toBeInTheDocument();
      expect(screen.getByText("Create drafts")).toBeInTheDocument();
      expect(screen.getByText("Send messages")).toBeInTheDocument();
    });
  });

  it("renders checkboxes for each email operation", async () => {
    mockAgentPerms([
      {
        connectionId: "email-1",
        connectionName: "Gmail Work",
        connectionType: "google",
        permissions: [{ model: "email", modelName: "Email", operation: "read" }],
      },
    ]);
    const onChange = vi.fn();

    render(
      <EmailPermissionSection
        agentId="agent-1"
        connections={[makeEmailConnection("email-1", "Gmail Work", "google")]}
        onChange={onChange}
      />
    );
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: /read.*email/i })).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: /draft.*email/i })).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: /send.*email/i })).toBeInTheDocument();
    });
  });

  it("checks the correct operations based on loaded permissions", async () => {
    mockAgentPerms([
      {
        connectionId: "email-1",
        connectionName: "Gmail Work",
        connectionType: "google",
        permissions: [
          { model: "email", modelName: "Email", operation: "read" },
          { model: "email", modelName: "Email", operation: "send" },
        ],
      },
    ]);
    const onChange = vi.fn();

    render(
      <EmailPermissionSection
        agentId="agent-1"
        connections={[makeEmailConnection("email-1", "Gmail Work", "google")]}
        onChange={onChange}
      />
    );
    await waitFor(() => {
      const readCheckbox = screen.getByRole("checkbox", { name: /read.*email/i });
      const draftCheckbox = screen.getByRole("checkbox", { name: /draft.*email/i });
      const sendCheckbox = screen.getByRole("checkbox", { name: /send.*email/i });

      expect(readCheckbox).toBeChecked();
      expect(draftCheckbox).not.toBeChecked();
      expect(sendCheckbox).toBeChecked();
    });
  });

  // MIGRATION TEST (AGENTS.md § "Test Migrations Against Pre-Existing Data"):
  // pre-#328 agent template creation could persist a standalone (email,
  // "search") or (email, "list") permission row with NO accompanying "read"
  // row (see tool-registry.ts EMAIL_OPERATIONS comment for the write-path
  // history). The runtime (getEmailToolsForOperations / checkPermission)
  // treats both as granting the full "read" toolset, so the UI must reflect
  // that effective grant instead of filtering the legacy row out — otherwise
  // the checkbox renders unchecked while email_list/email_read/email_search/
  // email_get_attachment are actually enabled, and a save on this section (or
  // an unrelated permissions-tab save that reuses this component's payload)
  // silently revokes read by writing back only the checked operations.
  describe("legacy operation rows (pre-#328 rows without a 'read' row)", () => {
    it("checks the 'read' checkbox when only a legacy 'search' row is loaded", async () => {
      mockAgentPerms([
        {
          connectionId: "email-1",
          connectionName: "Gmail Work",
          connectionType: "google",
          permissions: [{ model: "email", modelName: "Email", operation: "search" }],
        },
      ]);
      const onChange = vi.fn();

      render(
        <EmailPermissionSection
          agentId="agent-1"
          connections={[makeEmailConnection("email-1", "Gmail Work", "google")]}
          onChange={onChange}
        />
      );
      await waitFor(() => {
        const readCheckbox = screen.getByRole("checkbox", { name: /read.*email/i });
        expect(readCheckbox).toBeChecked();
      });
    });

    it("checks the 'read' checkbox when only a legacy 'list' row is loaded", async () => {
      mockAgentPerms([
        {
          connectionId: "email-1",
          connectionName: "Gmail Work",
          connectionType: "google",
          permissions: [{ model: "email", modelName: "Email", operation: "list" }],
        },
      ]);
      const onChange = vi.fn();

      render(
        <EmailPermissionSection
          agentId="agent-1"
          connections={[makeEmailConnection("email-1", "Gmail Work", "google")]}
          onChange={onChange}
        />
      );
      await waitFor(() => {
        const readCheckbox = screen.getByRole("checkbox", { name: /read.*email/i });
        expect(readCheckbox).toBeChecked();
      });
    });

    it("normalizes a legacy 'search' row to 'read' in the payload reported to onChange", async () => {
      mockAgentPerms([
        {
          connectionId: "email-1",
          connectionName: "Gmail Work",
          connectionType: "google",
          permissions: [{ model: "email", modelName: "Email", operation: "search" }],
        },
      ]);
      const onChange = vi.fn();

      render(
        <EmailPermissionSection
          agentId="agent-1"
          connections={[makeEmailConnection("email-1", "Gmail Work", "google")]}
          onChange={onChange}
        />
      );

      await waitFor(() => {
        const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
        expect(lastCall[0]).toEqual({
          connectionId: "email-1",
          permissions: [{ model: "email", operation: "read" }],
        });
      });
    });
  });

  it("calls onChange when an operation is toggled", async () => {
    mockAgentPerms([
      {
        connectionId: "email-1",
        connectionName: "Gmail Work",
        connectionType: "google",
        permissions: [{ model: "email", modelName: "Email", operation: "read" }],
      },
    ]);
    const onChange = vi.fn();

    render(
      <EmailPermissionSection
        agentId="agent-1"
        connections={[makeEmailConnection("email-1", "Gmail Work", "google")]}
        onChange={onChange}
      />
    );
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: /draft.*email/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("checkbox", { name: /draft.*email/i }));

    await waitFor(() => {
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
      expect(lastCall[0]).toEqual({
        connectionId: "email-1",
        permissions: expect.arrayContaining([
          { model: "email", operation: "read" },
          { model: "email", operation: "draft" },
        ]),
      });
      expect(lastCall[1]).toBe(true); // isDirty
    });
  });

  it("calls onChange with null when no connection is selected", async () => {
    mockAgentPerms();
    const onChange = vi.fn();

    render(
      <EmailPermissionSection
        agentId="agent-1"
        connections={[makeEmailConnection("email-1", "Gmail Work", "google")]}
        onChange={onChange}
      />
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(null, false);
    });
  });

  it("does not call /api/integrations (connections come from prop)", async () => {
    mockAgentPerms();
    const onChange = vi.fn();

    render(
      <EmailPermissionSection
        agentId="agent-1"
        connections={[makeEmailConnection("email-1", "Gmail Work", "google")]}
        onChange={onChange}
      />
    );
    await waitFor(() => {
      expect(screen.getByText("Connection")).toBeInTheDocument();
    });

    const calls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(calls).not.toContain("/api/integrations");
  });
});
