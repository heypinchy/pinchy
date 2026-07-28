// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChatImage } from "@/components/assistant-ui/chat-image";

// Mock Dialog components from shadcn/ui
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTrigger: ({ children, ...props }: { children: React.ReactNode; asChild?: boolean }) => (
    <div data-testid="dialog-trigger" {...props}>
      {children}
    </div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

describe("ChatImage", () => {
  it("should render a thumbnail image with constrained size", () => {
    render(<ChatImage image="data:image/png;base64,abc123" />);

    const img = screen.getAllByRole("img")[0];
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "data:image/png;base64,abc123");
    expect(img.className).toMatch(/max-h-64/);
    expect(img.className).toMatch(/max-w-sm/);
  });

  it("should render a full-size image in the dialog", () => {
    render(<ChatImage image="data:image/png;base64,abc123" />);

    const dialogContent = screen.getByTestId("dialog-content");
    const fullImg = dialogContent.querySelector("img");
    expect(fullImg).toBeInTheDocument();
    expect(fullImg).toHaveAttribute("src", "data:image/png;base64,abc123");
    expect(fullImg!.className).toMatch(/max-h-\[80vh\]/);
  });

  it("should have a clickable thumbnail that triggers the dialog", () => {
    render(<ChatImage image="data:image/png;base64,abc123" />);

    const trigger = screen.getByTestId("dialog-trigger");
    expect(trigger).toBeInTheDocument();
    const img = trigger.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img!.className).toMatch(/cursor-pointer/);
  });
});
