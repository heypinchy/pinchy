import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Chat } from "@/components/chat";

// Mock WebSocket
class MockWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

vi.stubGlobal("WebSocket", MockWebSocket);

describe("Chat", () => {
  it("should render agent name in header", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(screen.getByText("Smithers")).toBeInTheDocument();
  });

  it("should render message input", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(
      screen.getByPlaceholderText("Nachricht an Smithers..."),
    ).toBeInTheDocument();
  });

  it("should render send button", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(
      screen.getByRole("button", { name: "Senden" }),
    ).toBeInTheDocument();
  });
});
