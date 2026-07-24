import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

  it("opens the add dialog with name, base URL, and key fields — no discover step", async () => {
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
    // The server discovers models on save — there's no discover button, and the
    // manual model-ids field stays hidden until the server reports no models.
    expect(screen.queryByRole("button", { name: /discover/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Model IDs")).not.toBeInTheDocument();
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

  it("saves with just name, base URL, and key — no client model selection, no discover call", async () => {
    const user = userEvent.setup();
    let savedBody: Record<string, unknown> | undefined;
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/settings/providers/openai-compatible") && method === "GET") {
        return jsonResponse([]);
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
    await user.type(screen.getByLabelText("Name"), "Together AI");
    await user.type(screen.getByLabelText("Base URL"), "https://api.together.xyz/v1");
    await user.type(screen.getByLabelText("API key"), "sk-test-key");
    await user.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => {
      expect(savedBody).toBeDefined();
    });
    expect(savedBody).toMatchObject({
      displayName: "Together AI",
      baseUrl: "https://api.together.xyz/v1",
      apiKey: "sk-test-key",
    });
    // The client no longer curates a models list; the server discovers them.
    expect(savedBody!.models).toBeUndefined();
    expect(savedBody!.manualModelIds).toBeUndefined();
    // No separate discover request went out.
    const urls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/discover"))).toBe(false);
  });

  it("reveals the manual model-ids field when the server finds no models, then resends with manualModelIds", async () => {
    const user = userEvent.setup();
    let lastBody: Record<string, unknown> | undefined;
    let postCount = 0;
    vi.mocked(global.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/settings/providers/openai-compatible") && method === "GET") {
        return jsonResponse([]);
      }
      if (url.endsWith("/api/settings/providers/openai-compatible") && method === "POST") {
        postCount++;
        lastBody = JSON.parse(String(init?.body));
        if (postCount === 1) {
          // Endpoint exposes no /v1/models — the server asks for manual ids.
          return jsonResponse(
            {
              error: "No models found at this endpoint. Enter model ids manually.",
              details: {
                formErrors: [],
                fieldErrors: {
                  manualModelIds: ["No models found at this endpoint. Enter model ids manually."],
                },
              },
            },
            { ok: false, status: 422 }
          );
        }
        return jsonResponse({ id: "new-id" });
      }
      return jsonResponse({});
    });
    render(<OpenAiCompatibleProvidersSection />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add provider" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add provider" }));
    await user.type(screen.getByLabelText("Name"), "Bare vLLM");
    await user.type(screen.getByLabelText("Base URL"), "https://api.example.com/v1");
    await user.type(screen.getByLabelText("API key"), "sk-test-key");
    await user.click(screen.getByRole("button", { name: "Add provider" }));

    // First save found no models → the manual field appears with the message.
    await waitFor(() => {
      expect(screen.getByLabelText("Model IDs")).toBeInTheDocument();
    });
    expect(screen.getByText(/No models found at this endpoint/)).toBeInTheDocument();
    expect(lastBody!.manualModelIds).toBeUndefined();

    // Enter ids and resend: the manual ids are now carried, parsed and trimmed.
    await user.type(screen.getByLabelText("Model IDs"), "custom-a, custom-b");
    await user.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => {
      expect(postCount).toBe(2);
    });
    expect(lastBody!.manualModelIds).toEqual(["custom-a", "custom-b"]);
  });
});
