import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { NewAgentForm } from "@/components/new-agent-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
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
      expect(screen.getByText("Custom Agent")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Custom Agent"));

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toHaveAttribute("maxLength", "30");
    });
  });
});

describe("NewAgentForm — tagline field", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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
      expect(screen.getByText("Custom Agent")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Custom Agent"));

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
      expect(screen.getByText("Custom Agent")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Custom Agent"));

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
