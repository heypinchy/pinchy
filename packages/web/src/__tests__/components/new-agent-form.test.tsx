import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
