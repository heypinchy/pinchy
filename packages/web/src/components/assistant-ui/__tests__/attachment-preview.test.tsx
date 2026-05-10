import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

// Mock the chat module — we only need AgentIdContext from there. Recreating
// the context locally keeps the test independent of unrelated chat-component
// state.
vi.mock("@/components/chat", () => ({
  AgentIdContext: React.createContext<string | null>(null),
}));

// useMessagePartFile is the assistant-ui hook the component reads from.
const mockUseMessagePartFile = vi.fn();
vi.mock("@assistant-ui/react", () => ({
  useMessagePartFile: () => mockUseMessagePartFile(),
}));

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
  it("renders an <embed> thumbnail pointing at the uploads API URL", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: "Profile (38).pdf",
    });
    const { container } = await renderWithAgent("agent-1");
    const embed = container.querySelector("embed");
    expect(embed).toBeTruthy();
    expect(embed!.getAttribute("type")).toBe("application/pdf");
    // URL-encoded path with the agent id segment.
    expect(embed!.getAttribute("src")).toBe("/api/agents/agent-1/uploads/Profile%20(38).pdf");
  });

  it("opens a modal with a full-size PDF embed when the thumbnail is clicked", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: "invoice.pdf",
    });
    await renderWithAgent("agent-1");
    // The thumbnail itself is the trigger — assistant-ui's Dialog wraps it.
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
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/pdf",
      filename: "invoice.pdf",
    });
    await renderWithAgent(null);
    expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
    expect(screen.getByText("invoice.pdf")).toBeInTheDocument();
  });
});

describe("AttachmentPreview — image", () => {
  it("renders an inline <img> pointing at the uploads API URL", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "image/png",
      filename: "photo.png",
    });
    const { container } = await renderWithAgent("agent-1");
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toBe("/api/agents/agent-1/uploads/photo.png");
    // Alt text must be the filename — screen-reader accessible.
    expect(img!.getAttribute("alt")).toContain("photo.png");
  });

  it("opens a modal with the full image when the thumbnail is clicked", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "image/jpeg",
      filename: "selfie.jpg",
    });
    await renderWithAgent("agent-1");
    await userEvent.click(screen.getByRole("button", { name: /preview selfie\.jpg/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("AttachmentPreview — fallback chip", () => {
  it("renders a chip (no preview) for an unknown MIME type", async () => {
    mockUseMessagePartFile.mockReturnValue({
      mimeType: "application/zip",
      filename: "archive.zip",
    });
    const { container } = await renderWithAgent("agent-1");
    expect(container.querySelector("embed")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("archive.zip")).toBeInTheDocument();
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
