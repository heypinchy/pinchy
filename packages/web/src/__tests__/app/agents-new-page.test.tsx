import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/template-selector", () => ({
  TemplateSelector: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <div data-testid="template-selector">
      <button onClick={() => onSelect("knowledge-base")}>Knowledge Base</button>
      <button onClick={() => onSelect("custom")}>Custom Agent</button>
    </div>
  ),
}));

import { NewAgentForm } from "@/components/new-agent-form";
import { useRouter } from "next/navigation";

const TEMPLATES_WITH_DIRS = [
  {
    id: "knowledge-base",
    name: "Knowledge Base",
    description: "Answer questions from your docs",
    requiresDirectories: true,
  },
  {
    id: "custom",
    name: "Custom Agent",
    description: "Start from scratch",
    requiresDirectories: false,
  },
];

const DIRECTORIES = [
  { path: "/data/hr-docs", name: "hr-docs" },
  { path: "/data/eng-wiki", name: "eng-wiki" },
];

function mockFetch(dirs: typeof DIRECTORIES = DIRECTORIES) {
  vi.mocked(global.fetch).mockImplementation(async (url) => {
    if (String(url).includes("/api/templates")) {
      return {
        ok: true,
        json: async () => ({ templates: TEMPLATES_WITH_DIRS }),
      } as Response;
    }
    if (String(url).includes("/api/data-directories")) {
      return {
        ok: true,
        json: async () => ({ directories: dirs }),
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
}

describe("NewAgentForm", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
    mockFetch();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should show template selection initially", async () => {
    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByText("Create New Agent")).toBeInTheDocument();
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
  });

  it("should fetch directories when selecting a template that requires them", async () => {
    const user = userEvent.setup();
    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Knowledge Base"));

    await waitFor(() => {
      const fetchCalls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
      expect(fetchCalls.some((url) => url.includes("/api/data-directories"))).toBe(true);
    });
  });

  it("should NOT fetch directories when selecting a template that does not require them", async () => {
    const user = userEvent.setup();
    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Custom Agent"));
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    const fetchCalls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    expect(fetchCalls.some((url) => url.includes("/api/data-directories"))).toBe(false);
  });

  it("should show directory picker for knowledge-base template", async () => {
    const user = userEvent.setup();
    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Knowledge Base"));
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("hr-docs")).toBeInTheDocument();
      expect(screen.getByText("eng-wiki")).toBeInTheDocument();
    });
  });

  it("should show info box when no directories are available", async () => {
    mockFetch([]);
    const user = userEvent.setup();
    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Knowledge Base"));

    await waitFor(() => {
      expect(screen.getByText(/mount.*folders/i)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /how to mount data directories/i })).toHaveAttribute(
        "href",
        "https://docs.heypinchy.com/guides/mount-data-directories/"
      );
    });
  });

  it("should disable Create button when no directories are selected for KB template", async () => {
    const user = userEvent.setup();
    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Knowledge Base"));
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    // Fill name but don't select directories
    await user.type(screen.getByLabelText(/name/i), "Test Agent");
    expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
  });

  it("should enable Create button after selecting a directory for KB template", async () => {
    const user = userEvent.setup();
    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Knowledge Base"));
    await waitFor(() => {
      expect(screen.getByText("hr-docs")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("hr-docs"));
    expect(screen.getByRole("button", { name: /create/i })).not.toBeDisabled();
  });

  it("should send pluginConfig with allowed_paths for KB template", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push, back: vi.fn(), refresh: vi.fn() } as any);

    vi.mocked(global.fetch).mockImplementation(async (url, opts) => {
      if (String(url).includes("/api/agents") && opts?.method === "POST") {
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: "new-id", name: "Test KB" }),
        } as Response;
      }
      if (String(url).includes("/api/templates")) {
        return {
          ok: true,
          json: async () => ({ templates: TEMPLATES_WITH_DIRS }),
        } as Response;
      }
      if (String(url).includes("/api/data-directories")) {
        return {
          ok: true,
          json: async () => ({ directories: DIRECTORIES }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Knowledge Base"));
    await waitFor(() => {
      expect(screen.getByText("hr-docs")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText(/name/i), "Test KB");
    await user.click(screen.getByLabelText("hr-docs"));
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/chat/new-id");
    });

    const agentCall = vi
      .mocked(global.fetch)
      .mock.calls.find(
        (c) => String(c[0]).includes("/api/agents") && (c[1] as any)?.method === "POST"
      );
    expect(agentCall).toBeDefined();
    const sentBody = JSON.parse((agentCall![1] as any).body);
    expect(sentBody.pluginConfig).toEqual({ allowed_paths: ["/data/hr-docs"] });
  });

  it("should show docs link for knowledge-base template", async () => {
    const user = userEvent.setup();
    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Knowledge Base"));
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    expect(
      screen.getByRole("link", { name: /learn more about knowledge base agents/i })
    ).toHaveAttribute("href", "https://docs.heypinchy.com/guides/create-knowledge-base-agent/");
  });

  it("should NOT show directory picker for custom template", async () => {
    const user = userEvent.setup();
    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Custom Agent"));
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    expect(screen.queryByText("hr-docs")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create/i })).not.toBeDisabled();
  });

  it("should submit custom agent without pluginConfig", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push, back: vi.fn(), refresh: vi.fn() } as any);

    vi.mocked(global.fetch).mockImplementation(async (url, opts) => {
      if (String(url).includes("/api/agents") && opts?.method === "POST") {
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: "new-id", name: "Dev Bot" }),
        } as Response;
      }
      if (String(url).includes("/api/templates")) {
        return {
          ok: true,
          json: async () => ({ templates: TEMPLATES_WITH_DIRS }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Custom Agent"));
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText(/name/i), "Dev Bot");
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/chat/new-id");
    });

    const agentCall = vi
      .mocked(global.fetch)
      .mock.calls.find(
        (c) => String(c[0]).includes("/api/agents") && (c[1] as any)?.method === "POST"
      );
    const sentBody = JSON.parse((agentCall![1] as any).body);
    expect(sentBody).not.toHaveProperty("pluginConfig");
  });

  it("should show validation error when submitting with empty name", async () => {
    const user = userEvent.setup();
    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Custom Agent"));
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalledWith("/api/agents", expect.anything());
  });

  it("should render Back to templates link outside the form element", async () => {
    const user = userEvent.setup();
    render(<NewAgentForm />);
    await waitFor(() => {
      expect(screen.getByTestId("template-selector")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Knowledge Base"));
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    });

    const backButton = screen.getByText(/back to templates/i);
    expect(backButton).toBeInTheDocument();

    const formElement = screen.getByLabelText(/name/i).closest("form");
    expect(formElement).not.toContainElement(backButton);
  });
});
