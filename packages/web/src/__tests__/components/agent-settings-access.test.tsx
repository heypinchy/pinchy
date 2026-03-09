import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentSettingsAccess } from "@/components/agent-settings-access";

describe("AgentSettingsAccess", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockGroups = [
    { id: "g1", name: "Engineering", description: "Dev team", memberCount: 3 },
    { id: "g2", name: "Design", description: null, memberCount: 1 },
  ];

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();

    vi.mocked(global.fetch).mockImplementation(async (url) => {
      if (String(url) === "/api/enterprise/status") {
        return { ok: true, json: async () => ({ enterprise: true }) } as Response;
      }
      if (String(url) === "/api/groups") {
        return { ok: true, json: async () => mockGroups } as Response;
      }
      return { ok: false } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should render dropdown with current visibility", async () => {
    const onChange = vi.fn();
    render(
      <AgentSettingsAccess agent={{ visibility: "all" }} currentGroupIds={[]} onChange={onChange} />
    );

    await waitFor(() => {
      expect(screen.getByText("All users")).toBeInTheDocument();
    });
  });

  it("should show group checkboxes when 'Specific groups' is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AgentSettingsAccess
        agent={{ visibility: "groups" }}
        currentGroupIds={["g1"]}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Engineering")).toBeInTheDocument();
      expect(screen.getByText("Design")).toBeInTheDocument();
    });

    // Engineering should be checked (in currentGroupIds)
    const engCheckbox = screen.getByRole("checkbox", { name: "Engineering" });
    expect(engCheckbox).toBeChecked();

    const designCheckbox = screen.getByRole("checkbox", { name: "Design" });
    expect(designCheckbox).not.toBeChecked();
  });

  it("should call onChange with isDirty false when visibility matches initial", async () => {
    const onChange = vi.fn();
    render(
      <AgentSettingsAccess
        agent={{ visibility: "admin_only" }}
        currentGroupIds={[]}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Admins only")).toBeInTheDocument();
    });

    // Initial render calls onChange with isDirty=false
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ visibility: "admin_only", groupIds: [] }, false);
    });
  });

  it("should call onChange when group selection changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AgentSettingsAccess
        agent={{ visibility: "groups" }}
        currentGroupIds={[]}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Design")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("checkbox", { name: "Design" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ visibility: "groups", groupIds: ["g2"] }, true);
    });
  });

  it("should show enterprise feature card when enterprise is not active", async () => {
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      if (String(url) === "/api/enterprise/status") {
        return { ok: true, json: async () => ({ enterprise: false }) } as Response;
      }
      return { ok: false } as Response;
    });

    const onChange = vi.fn();
    render(
      <AgentSettingsAccess
        agent={{ visibility: "admin_only" }}
        currentGroupIds={[]}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Access Control")).toBeInTheDocument();
    });

    expect(screen.getByText("Enterprise")).toBeInTheDocument();
    expect(
      screen.getByText(/Control which users and groups can access this agent/)
    ).toBeInTheDocument();
  });
});
