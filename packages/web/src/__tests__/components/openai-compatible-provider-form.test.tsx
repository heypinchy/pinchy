import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { OpenAiCompatibleProvidersSection } from "@/components/openai-compatible-provider-form";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("OpenAiCompatibleProvidersSection", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockProviders = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      slug: "together-ai",
      displayName: "Together AI",
      baseUrl: "https://api.together.xyz/v1",
      models: [
        {
          id: "llama-3.1-70b",
          name: "Llama 3.1 70B",
          contextWindow: 131072,
          maxTokens: 8192,
          reasoning: false,
          vision: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      keyHint: "cdef",
    },
  ];

  function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
    const text = JSON.stringify(body);
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => text,
    } as unknown as Response;
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("lists configured providers with host and key hint, never the key", async () => {
    vi.mocked(global.fetch).mockImplementation(async () => jsonResponse(mockProviders));
    render(<OpenAiCompatibleProvidersSection />);

    await waitFor(() => {
      expect(screen.getByText("Together AI")).toBeInTheDocument();
    });
    // Host + last-4 hint shown for identification; the API key is never in the DOM.
    expect(screen.getByText(/api\.together\.xyz/)).toBeInTheDocument();
    expect(screen.getByText(/····cdef/)).toBeInTheDocument();
  });

  it("opens the add dialog with name, base URL, key fields and a discover button", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockImplementation(async () => jsonResponse([]));
    render(<OpenAiCompatibleProvidersSection />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add provider" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add provider" }));

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    const keyField = screen.getByLabelText("API key");
    expect(keyField).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Connect & discover models" })).toBeInTheDocument();
  });

  it("edit dialog shows the leave-blank placeholder and never the stored key", async () => {
    const user = userEvent.setup();
    vi.mocked(global.fetch).mockImplementation(async () => jsonResponse(mockProviders));
    render(<OpenAiCompatibleProvidersSection />);

    await waitFor(() => {
      expect(screen.getByText("Together AI")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit Together AI" }));

    const keyField = screen.getByLabelText("API key") as HTMLInputElement;
    expect(keyField.value).toBe("");
    expect(keyField).toHaveAttribute("placeholder", "Leave blank to keep current key");
  });

  it("discover renders a checklist of models with no context-window or vision controls, and saving still sends full model defs", async () => {
    const user = userEvent.setup();
    const discoveredModel = {
      id: "llama-3.1-70b",
      name: "Llama 3.1 70B",
      contextWindow: 131072,
      maxTokens: 8192,
      reasoning: false,
      vision: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    let savedBody: unknown;
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/settings/providers/openai-compatible") && method === "GET") {
        return jsonResponse([]);
      }
      if (url.endsWith("/discover") && method === "POST") {
        return jsonResponse({ ok: true, models: [discoveredModel] });
      }
      if (url.endsWith("/api/settings/providers/openai-compatible") && method === "POST") {
        savedBody = JSON.parse(String(init?.body));
        return jsonResponse({ id: "new-id" });
      }
      return jsonResponse({});
    });
    render(<OpenAiCompatibleProvidersSection />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add provider" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add provider" }));
    await user.type(screen.getByLabelText("Base URL"), "https://api.together.xyz/v1");
    await user.type(screen.getByLabelText("API key"), "sk-test-key");
    await user.click(screen.getByRole("button", { name: "Connect & discover models" }));

    await waitFor(() => {
      expect(screen.getByText("Llama 3.1 70B")).toBeInTheDocument();
    });
    // Checklist entry: a checkbox plus id/name — no per-model editing controls.
    const modelRow = screen.getByText("Llama 3.1 70B").closest("label");
    expect(modelRow).not.toBeNull();
    expect(within(modelRow!).getByRole("checkbox")).toBeChecked();
    expect(within(modelRow!).getByText("llama-3.1-70b")).toBeInTheDocument();
    expect(screen.queryByLabelText(/context window/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Vision")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => {
      expect(savedBody).toBeDefined();
    });
    expect((savedBody as { models: unknown[] }).models).toEqual([discoveredModel]);
  });

  it("manual entry adds a model by id with default capabilities and keeps it selectable via checkbox", async () => {
    const user = userEvent.setup();
    let savedBody: unknown;
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/settings/providers/openai-compatible") && method === "GET") {
        return jsonResponse([]);
      }
      if (url.endsWith("/discover") && method === "POST") {
        return jsonResponse({ ok: true, models: [], manualEntry: true });
      }
      if (url.endsWith("/api/settings/providers/openai-compatible") && method === "POST") {
        savedBody = JSON.parse(String(init?.body));
        return jsonResponse({ id: "new-id" });
      }
      return jsonResponse({});
    });
    render(<OpenAiCompatibleProvidersSection />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add provider" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add provider" }));
    await user.type(screen.getByLabelText("Base URL"), "https://api.example.com/v1");
    await user.type(screen.getByLabelText("API key"), "sk-test-key");
    await user.click(screen.getByRole("button", { name: "Connect & discover models" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Add model id")).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText("Add model id"), "custom-model-x");
    await user.click(screen.getByRole("button", { name: "Add" }));

    const modelRow = screen.getAllByText("custom-model-x")[0].closest("label");
    expect(modelRow).not.toBeNull();
    const checkbox = within(modelRow!).getByRole("checkbox");
    expect(checkbox).toBeChecked();

    // Deselecting via the checklist checkbox excludes it from the save payload.
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => {
      expect(screen.getByText(/Pick at least one model/)).toBeInTheDocument();
    });
    expect(savedBody).toBeUndefined();

    // Re-select and save: default capabilities still flow through in full.
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => {
      expect(savedBody).toBeDefined();
    });
    expect((savedBody as { models: { id: string; contextWindow: number }[] }).models).toEqual([
      {
        id: "custom-model-x",
        name: "custom-model-x",
        contextWindow: 32768,
        maxTokens: 8192,
        reasoning: false,
        vision: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });
});
