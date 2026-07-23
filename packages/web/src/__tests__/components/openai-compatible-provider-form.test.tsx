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
});
