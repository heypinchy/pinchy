import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

// Mock the chat module — we only need AgentIdContext and AgentModelContext
// from there. Recreating the contexts locally keeps the test independent of
// unrelated chat-component state.
vi.mock("@/components/chat", () => ({
  AgentIdContext: React.createContext<string | null>(null),
  AgentModelContext: React.createContext<string | null>(null),
}));

// useMessagePartFile is the assistant-ui hook the component reads from.
const mockUseMessagePartFile = vi.fn();
vi.mock("@assistant-ui/react", () => ({
  useMessagePartFile: () => mockUseMessagePartFile(),
}));

// Capability data comes from the useModelCapabilities hook.
const mockUseModelCapabilities = vi.fn();
vi.mock("@/hooks/use-model-capabilities", () => ({
  useModelCapabilities: () => mockUseModelCapabilities(),
}));

// All previewable MIME types go through a HEAD probe before the <embed>/<img>
// is mounted (race-fix in #324). Default fetch mock returns 200.
function mockFetchOk() {
  global.fetch = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch;
}

beforeEach(() => {
  mockFetchOk();
  mockUseModelCapabilities.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: undefined,
    refetch: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderWithAgent(agentId: string | null) {
  const { AgentIdContext } = await import("@/components/chat");
  const { AttachmentPreview } = await import("@/components/assistant-ui/attachment-preview");
  return render(
    <AgentIdContext.Provider value={agentId}>
      <AttachmentPreview />
    </AgentIdContext.Provider>
  );
}

describe("AttachmentPreview — PDF", () => {
  it("renders an <embed> thumbnail pointing at the uploads API URL immediately on mount without any HEAD fetch", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: "Profile (38).pdf",
    });
    const { container } = await renderWithAgent("agent-1");
    const embed = container.querySelector("embed");
    expect(embed).not.toBeNull();
    expect(embed!.getAttribute("type")).toBe("application/pdf");
    // URL-encoded path with the agent id segment.
    expect(embed!.getAttribute("src")).toBe("/api/agents/agent-1/uploads/Profile%20(38).pdf");
    // No HEAD probe should be issued.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("opens a modal with a full-size PDF embed when the thumbnail is clicked", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: "invoice.pdf",
    });
    await renderWithAgent("agent-1");
    // The thumbnail itself is the trigger — the component uses shadcn/ui Dialog
    // from @/components/ui/dialog, not assistant-ui.
    const trigger = screen.getByRole("button", { name: /preview invoice\.pdf/i });
    await userEvent.click(trigger);
    // Modal content uses a unique label so we can assert it's open.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // The modal embed should also point at the same API URL.
    const modalEmbed = screen.getByRole("dialog").querySelector("embed");
    expect(modalEmbed?.getAttribute("src")).toBe("/api/agents/agent-1/uploads/invoice.pdf");
  });

  it("renders a fallback chip when there is no agent id in context (defensive)", async () => {
    // Without an agentId we cannot build the URL — render the chip rather
    // than emitting an <embed> with a half-broken src.
    global.fetch = vi.fn() as unknown as typeof fetch;
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: "invoice.pdf",
    });
    await renderWithAgent(null);
    expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
    expect(screen.getByText("invoice.pdf")).toBeInTheDocument();
    // No fetch should be issued for the chip path.
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("AttachmentPreview — image", () => {
  it("renders an inline <img> pointing at the uploads API URL immediately on mount without any HEAD fetch", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "image/png",
      filename: "photo.png",
    });
    const { container } = await renderWithAgent("agent-1");
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/api/agents/agent-1/uploads/photo.png");
    // Alt text must be the filename — screen-reader accessible.
    expect(img!.getAttribute("alt")).toContain("photo.png");
    // No HEAD probe should be issued.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("opens a modal with the full image when the thumbnail is clicked", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "image/jpeg",
      filename: "selfie.jpg",
    });
    await renderWithAgent("agent-1");
    const trigger = screen.getByRole("button", { name: /preview selfie\.jpg/i });
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const modalImg = screen.getByRole("dialog").querySelector("img");
    expect(modalImg?.getAttribute("src")).toBe("/api/agents/agent-1/uploads/selfie.jpg");
  });

  it("renders a fallback chip when there is no agent id in context (defensive)", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "image/png",
      filename: "photo.png",
    });
    const { container } = await renderWithAgent(null);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("photo.png")).toBeInTheDocument();
  });
});

describe("AttachmentPreview — fallback chip", () => {
  it("renders a chip (no preview) for an unknown MIME type", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/zip",
      filename: "archive.zip",
    });
    const { container } = await renderWithAgent("agent-1");
    expect(container.querySelector("embed")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("archive.zip")).toBeInTheDocument();
    // The chip path skips any fetch entirely.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("renders a chip with a default filename when none is provided", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: undefined,
    });
    await renderWithAgent("agent-1");
    // Without a filename we cannot build a URL — show a chip.
    expect(screen.getByText(/PDF document/i)).toBeInTheDocument();
  });
});

// ── Amber capability warning ─────────────────────────────────────────────
//
// When the current model lacks the capability required by the attached file,
// the preview should display a soft amber warning so the user knows the
// attachment won't be understood by the model. The component derives its
// capability data from AgentModelContext + useModelCapabilities — these tests
// provide both so the warning logic is actually exercised.
describe("AttachmentPreview — amber capability warning", () => {
  const TEXT_ONLY_MODEL = "ollama-cloud/text-only";
  const VISION_MODEL = "anthropic/claude-sonnet";

  async function renderWithModel(agentModel: string | null) {
    const { AgentIdContext, AgentModelContext } = await import("@/components/chat");
    const { AttachmentPreview } = await import("@/components/assistant-ui/attachment-preview");
    return render(
      <AgentIdContext.Provider value="agent-1">
        <AgentModelContext.Provider value={agentModel}>
          <AttachmentPreview />
        </AgentModelContext.Provider>
      </AgentIdContext.Provider>
    );
  }

  it("shows amber warning when image attached and model has no vision", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "image/png",
      filename: "screenshot.png",
    });
    mockUseModelCapabilities.mockReturnValue({
      data: {
        [TEXT_ONLY_MODEL]: {
          vision: false,
          documents: false,
          audio: false,
          video: false,
          longContext: false,
          tools: true,
        },
      },
      isLoading: false,
      error: undefined,
      refetch: vi.fn(),
    });
    await renderWithModel(TEXT_ONLY_MODEL);
    expect(await screen.findByText(/doesn't support image input/i)).toBeInTheDocument();
  });

  it("shows amber warning when PDF attached and model has no document support", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: "report.pdf",
    });
    mockUseModelCapabilities.mockReturnValue({
      data: {
        [TEXT_ONLY_MODEL]: {
          vision: false,
          documents: false,
          audio: false,
          video: false,
          longContext: false,
          tools: true,
        },
      },
      isLoading: false,
      error: undefined,
      refetch: vi.fn(),
    });
    await renderWithModel(TEXT_ONLY_MODEL);
    expect(await screen.findByText(/doesn't support document input/i)).toBeInTheDocument();
  });

  it("shows no warning when model has matching capability for image", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "image/png",
      filename: "screenshot.png",
    });
    mockUseModelCapabilities.mockReturnValue({
      data: {
        [VISION_MODEL]: {
          vision: true,
          documents: true,
          audio: false,
          video: false,
          longContext: false,
          tools: true,
        },
      },
      isLoading: false,
      error: undefined,
      refetch: vi.fn(),
    });
    await renderWithModel(VISION_MODEL);
    await waitFor(() => {
      expect(screen.queryByText(/doesn't support/i)).not.toBeInTheDocument();
    });
  });

  it("shows no warning when capability map is not yet loaded", async () => {
    // Default beforeEach mock already returns data: undefined.
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "image/png",
      filename: "screenshot.png",
    });
    await renderWithModel(TEXT_ONLY_MODEL);
    await waitFor(() => {
      expect(screen.queryByText(/doesn't support/i)).not.toBeInTheDocument();
    });
  });

  it("shows no warning when no agent model is in context", async () => {
    // Without a model we can't know what the agent supports — withhold the
    // warning rather than guessing.
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "image/png",
      filename: "screenshot.png",
    });
    mockUseModelCapabilities.mockReturnValue({
      data: {
        [TEXT_ONLY_MODEL]: {
          vision: false,
          documents: false,
          audio: false,
          video: false,
          longContext: false,
          tools: true,
        },
      },
      isLoading: false,
      error: undefined,
      refetch: vi.fn(),
    });
    await renderWithModel(null);
    await waitFor(() => {
      expect(screen.queryByText(/doesn't support/i)).not.toBeInTheDocument();
    });
  });
});

// ── HEAD-probe race fix (#324) ──────────────────────────────────────────
//
// The server persists the uploaded file AFTER the WS message lands, but the
// browser renders this component as soon as the user message hits local
// state. A naive <embed src=…> would 404 against the still-pending file and
// the user sees "Not found" until they reload. These tests pin the probe
// behaviour that papers over that race for v0.5.3.
describe("AttachmentPreview — HEAD-probe race fix", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not mount the <embed> while the first HEAD probe is still pending", async () => {
    global.fetch = vi
      .fn()
      .mockImplementation(() => new Promise(() => {})) as unknown as typeof fetch;
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: "race.pdf",
    });
    const { container } = await renderWithAgent("agent-1");
    expect(container.querySelector("embed")).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-1/uploads/race.pdf",
      expect.objectContaining({ method: "HEAD" })
    );
  });

  it("retries on 404 with exponential backoff and renders <embed> once reachable", async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call <= 2) return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: "slow.pdf",
    });

    const { container } = await renderWithAgent("agent-1");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector("embed")).toBeNull();

    // Backoff steps: 200, 400, 800, 1600 ms. Walk through the first two.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector("embed")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    // Third probe resolves to 200 → component mounts the embed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(container.querySelector("embed")?.getAttribute("src")).toBe(
      "/api/agents/agent-1/uploads/slow.pdf"
    );
  });

  it("falls back to a chip after the retry budget is exhausted", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 })) as unknown as typeof fetch;
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: "missing.pdf",
    });

    const { container } = await renderWithAgent("agent-1");

    // The schedule is 200 + 400 + 800 + 1600 = 3000 ms across 4 retries plus
    // the initial probe — drain it generously.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(container.querySelector("embed")).toBeNull();
    // Filename remains visible to the user so the attachment is not silently lost.
    expect(screen.getByText("missing.pdf")).toBeInTheDocument();
  });

  it("aborts the in-flight probe when the component unmounts", async () => {
    const abortSpy = vi.fn();
    const fetchSpy = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", abortSpy);
      return new Promise(() => {});
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: "race.pdf",
    });

    const { unmount } = await renderWithAgent("agent-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    unmount();
    expect(abortSpy).toHaveBeenCalled();
  });
});
