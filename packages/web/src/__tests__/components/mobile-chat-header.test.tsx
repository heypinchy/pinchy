import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MobileChatHeader } from "@/components/mobile-chat-header";

describe("MobileChatHeader", () => {
  const defaultProps = {
    agentId: "agent-123",
    agentName: "Smithers",
  };

  it("renders a header element with border-b", () => {
    render(<MobileChatHeader {...defaultProps} />);
    const header = screen.getByRole("banner");
    expect(header).toHaveClass("border-b");
  });

  it("is hidden on md screens and above", () => {
    render(<MobileChatHeader {...defaultProps} />);
    const header = screen.getByRole("banner");
    expect(header).toHaveClass("md:hidden");
  });

  it("renders a back link to /agents with aria-label", () => {
    render(<MobileChatHeader {...defaultProps} />);
    const backLink = screen.getByRole("link", { name: "Back" });
    expect(backLink).toHaveAttribute("href", "/agents");
  });

  it("renders the agent name", () => {
    render(<MobileChatHeader {...defaultProps} />);
    expect(screen.getByText("Smithers")).toBeInTheDocument();
  });

  it("truncates the agent name", () => {
    render(<MobileChatHeader {...defaultProps} />);
    const name = screen.getByText("Smithers");
    expect(name).toHaveClass("truncate");
  });

  it("renders the agent name in bold", () => {
    render(<MobileChatHeader {...defaultProps} />);
    const name = screen.getByText("Smithers");
    expect(name).toHaveClass("font-bold");
  });

  it("renders a settings link when canEdit is true", () => {
    render(<MobileChatHeader {...defaultProps} canEdit={true} />);
    const settingsLink = screen.getByRole("link", { name: "Settings" });
    expect(settingsLink).toHaveAttribute("href", "/chat/agent-123/settings");
  });

  it("does not render a settings link when canEdit is false", () => {
    render(<MobileChatHeader {...defaultProps} canEdit={false} />);
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("does not render an avatar when avatarUrl is not provided", () => {
    render(<MobileChatHeader {...defaultProps} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders an avatar when avatarUrl is provided", () => {
    render(<MobileChatHeader {...defaultProps} avatarUrl="/avatar.png" />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("alt", "Smithers");
    expect(img).toHaveClass("size-6");
  });
});
