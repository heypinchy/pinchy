import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AiDisclosureBadge } from "@/components/ai-disclosure-badge";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip">{children}</div>
  ),
}));

describe("AiDisclosureBadge (#115)", () => {
  it("renders the 'AI assistant' label", () => {
    render(<AiDisclosureBadge />);
    expect(screen.getByTestId("ai-disclosure-badge")).toHaveTextContent("AI assistant");
  });

  it("carries a tooltip informing the user they are chatting with an AI", () => {
    render(<AiDisclosureBadge />);
    expect(screen.getByTestId("tooltip")).toHaveTextContent(/chatting with an AI/i);
  });
});
