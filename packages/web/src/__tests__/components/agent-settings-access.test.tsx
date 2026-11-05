// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { AgentSettingsAccess } from "@/components/agent-settings-access";
import { jsonResponse } from "@/test-helpers/fetch";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));

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
        return jsonResponse({ enterprise: true });
      }
      if (String(url) === "/api/groups") {
        return jsonResponse(mockGroups);
      }
      return jsonResponse(undefined, { status: 404 });
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

  it("should show group checkboxes when 'Restricted' is selected", async () => {
    const onChange = vi.fn();
    render(
      <AgentSettingsAccess
        agent={{ visibility: "restricted" }}
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
        agent={{ visibility: "restricted" }}
        currentGroupIds={[]}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Restricted")).toBeInTheDocument();
    });

    // Initial render calls onChange with isDirty=false
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ visibility: "restricted", groupIds: [] }, false);
    });
  });

  it("should call onChange when group selection changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AgentSettingsAccess
        agent={{ visibility: "restricted" }}
        currentGroupIds={[]}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Design")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("checkbox", { name: "Design" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ visibility: "restricted", groupIds: ["g2"] }, true);
    });
  });

  it("should detect dirty state after props update from parent refetch", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    // Initial render: agent has no groups assigned
    const { rerender } = render(
      <AgentSettingsAccess
        agent={{ visibility: "restricted" }}
        currentGroupIds={[]}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Engineering")).toBeInTheDocument();
    });

    // User adds Engineering group
    await user.click(screen.getByRole("checkbox", { name: "Engineering" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ visibility: "restricted", groupIds: ["g1"] }, true);
    });

    // Simulate save + parent refetch: parent re-renders with updated groupIds
    onChange.mockClear();
    rerender(
      <AgentSettingsAccess
        agent={{ visibility: "restricted" }}
        currentGroupIds={["g1"]}
        onChange={onChange}
      />
    );

    // After props update, component should recognize the new baseline
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ visibility: "restricted", groupIds: ["g1"] }, false);
    });

    // Now user removes Engineering group
    onChange.mockClear();
    await user.click(screen.getByRole("checkbox", { name: "Engineering" }));

    // Should be dirty because we changed from the new baseline
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ visibility: "restricted", groupIds: [] }, true);
    });
  });

  it("should show enterprise feature card when enterprise is not active", async () => {
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      if (String(url) === "/api/enterprise/status") {
        return jsonResponse({ enterprise: false });
      }
      return jsonResponse(undefined, { status: 404 });
    });

    const onChange = vi.fn();
    render(
      <AgentSettingsAccess
        agent={{ visibility: "restricted" }}
        currentGroupIds={[]}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Access Control")).toBeInTheDocument();
    });

    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(
      screen.getByText(/Control which users and groups can access this agent/)
    ).toBeInTheDocument();
  });

  // "Couldn't ask" is not "community": an enterprise admin whose status fetch
  // was dropped by a restarting server must not be told to upgrade.
  it.each([
    ["the status fetch rejects", () => Promise.reject(new TypeError("Failed to fetch"))],
    [
      "the status fetch answers 500",
      async () => jsonResponse({ error: "Internal Server Error" }, { status: 500 }),
    ],
  ])("does not render the upgrade card when %s", async (_label, statusResponse) => {
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      if (String(url) === "/api/enterprise/status") return statusResponse();
      return jsonResponse(undefined, { status: 404 });
    });

    render(
      <AgentSettingsAccess
        agent={{ visibility: "restricted" }}
        currentGroupIds={[]}
        onChange={vi.fn()}
        isAdmin
      />
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/license status/i), {
        id: expect.any(String),
      });
    });
    expect(screen.queryByText("Access Control")).not.toBeInTheDocument();
    expect(screen.queryByText("Pro")).not.toBeInTheDocument();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });
});
