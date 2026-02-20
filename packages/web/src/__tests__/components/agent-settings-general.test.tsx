import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentSettingsGeneral } from "@/components/agent-settings-general";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

describe("AgentSettingsGeneral", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const defaultAgent = {
    id: "agent-1",
    name: "Smithers",
    model: "anthropic/claude-sonnet-4-20250514",
  };
  const defaultProviders = [
    {
      id: "anthropic",
      name: "Anthropic",
      models: [
        { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
        { id: "anthropic/claude-opus-4-20250514", name: "Claude Opus 4" },
      ],
    },
    {
      id: "openai",
      name: "OpenAI",
      models: [{ id: "openai/gpt-4o", name: "GPT-4o" }],
    },
  ];

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should render a Name label and input pre-filled with agent name", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toHaveValue("Smithers");
  });

  it("should render a Model label and select element", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/model/i).tagName).toBe("SELECT");
  });

  it("should group models by provider in the select", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    const select = screen.getByLabelText(/model/i);
    const optgroups = select.querySelectorAll("optgroup");
    expect(optgroups).toHaveLength(2);
    expect(optgroups[0]).toHaveAttribute("label", "Anthropic");
    expect(optgroups[1]).toHaveAttribute("label", "OpenAI");
  });

  it("should pre-select the current model", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(screen.getByLabelText(/model/i)).toHaveValue("anthropic/claude-sonnet-4-20250514");
  });

  it("should only show providers that have models", () => {
    const providersWithEmpty = [...defaultProviders, { id: "google", name: "Google", models: [] }];

    render(<AgentSettingsGeneral agent={defaultAgent} providers={providersWithEmpty} />);

    const select = screen.getByLabelText(/model/i);
    const optgroups = select.querySelectorAll("optgroup");
    expect(optgroups).toHaveLength(2); // Google excluded because no models
  });

  it("should render a Save button", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("should show the restart warning text", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(
      screen.getByText(
        /saving will briefly disconnect all active chats while the agent runtime restarts/i
      )
    ).toBeInTheDocument();
  });

  it("should PATCH the agent API with name and model on save", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "agent-1",
        name: "Smithers",
        model: "anthropic/claude-sonnet-4-20250514",
      }),
    } as Response);

    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/agents/agent-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Smithers", model: "anthropic/claude-sonnet-4-20250514" }),
      });
    });
  });

  it("should send updated name and model values on save", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "agent-1", name: "Jeeves", model: "openai/gpt-4o" }),
    } as Response);

    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: "Jeeves" },
    });
    fireEvent.change(screen.getByLabelText(/model/i), {
      target: { value: "openai/gpt-4o" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/agents/agent-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Jeeves", model: "openai/gpt-4o" }),
      });
    });
  });

  it("should show success feedback after successful save", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "agent-1",
        name: "Smithers",
        model: "anthropic/claude-sonnet-4-20250514",
      }),
    } as Response);

    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByText(/saved/i)).toBeInTheDocument();
    });
  });

  it("should show error feedback after failed save", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Something went wrong" }),
    } as Response);

    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });
  });

  it("should call onSaved callback after successful save", async () => {
    const onSaved = vi.fn();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "agent-1",
        name: "Smithers",
        model: "anthropic/claude-sonnet-4-20250514",
      }),
    } as Response);

    render(
      <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} onSaved={onSaved} />
    );

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
  });

  describe("canDelete prop", () => {
    it("should render Delete Agent button when canDelete is true", () => {
      render(
        <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} canDelete={true} />
      );

      expect(screen.getByRole("button", { name: /delete agent/i })).toBeInTheDocument();
    });

    it("should render Danger Zone heading when canDelete is true", () => {
      render(
        <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} canDelete={true} />
      );

      expect(screen.getByText("Danger Zone")).toBeInTheDocument();
    });

    it("should NOT render Delete Agent button when canDelete is false", () => {
      render(
        <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} canDelete={false} />
      );

      expect(screen.queryByRole("button", { name: /delete agent/i })).not.toBeInTheDocument();
    });

    it("should NOT render Delete Agent button when canDelete is undefined", () => {
      render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

      expect(screen.queryByRole("button", { name: /delete agent/i })).not.toBeInTheDocument();
    });
  });
});
