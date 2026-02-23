import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DeleteAgentDialog } from "@/components/delete-agent-dialog";

const pushMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    refresh: refreshMock,
  }),
}));

describe("DeleteAgentDialog", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should render a Delete Agent button", () => {
    render(<DeleteAgentDialog agentId="agent-1" agentName="Smithers" />);

    expect(screen.getByRole("button", { name: /delete agent/i })).toBeInTheDocument();
  });

  it("should show confirmation dialog with agent name when clicked", () => {
    render(<DeleteAgentDialog agentId="agent-1" agentName="Smithers" />);

    fireEvent.click(screen.getByRole("button", { name: /delete agent/i }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Delete Smithers?")).toBeInTheDocument();
    expect(
      screen.getByText(/this will permanently delete the agent and its configuration/i)
    ).toBeInTheDocument();
  });

  it("should call DELETE /api/agents/:id when confirmed", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<DeleteAgentDialog agentId="agent-1" agentName="Smithers" />);

    fireEvent.click(screen.getByRole("button", { name: /delete agent/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/agents/agent-1", {
        method: "DELETE",
      });
    });
  });

  it("should redirect to / on successful delete", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<DeleteAgentDialog agentId="agent-1" agentName="Smithers" />);

    fireEvent.click(screen.getByRole("button", { name: /delete agent/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/");
    });
  });

  it("should show error message on failure", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Personal agents cannot be deleted" }),
    } as Response);

    render(<DeleteAgentDialog agentId="agent-1" agentName="Smithers" />);

    fireEvent.click(screen.getByRole("button", { name: /delete agent/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.getByText("Personal agents cannot be deleted")).toBeInTheDocument();
    });
  });

  it("should not redirect on failure", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Failed to delete agent" }),
    } as Response);

    render(<DeleteAgentDialog agentId="agent-1" agentName="Smithers" />);

    fireEvent.click(screen.getByRole("button", { name: /delete agent/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.getByText("Failed to delete agent")).toBeInTheDocument();
    });

    expect(pushMock).not.toHaveBeenCalled();
  });

  it("should show generic error message on network failure", async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce(new Error("Network error"));

    render(<DeleteAgentDialog agentId="agent-1" agentName="Smithers" />);

    fireEvent.click(screen.getByRole("button", { name: /delete agent/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.getByText("Failed to delete agent")).toBeInTheDocument();
    });
  });

  it("should not call DELETE when Cancel is clicked", () => {
    render(<DeleteAgentDialog agentId="agent-1" agentName="Smithers" />);

    fireEvent.click(screen.getByRole("button", { name: /delete agent/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
