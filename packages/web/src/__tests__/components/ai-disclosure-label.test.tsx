import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AiDisclosureLabel } from "@/components/ai-disclosure-label";

describe("AiDisclosureLabel (#115)", () => {
  it("renders the 'AI assistant' disclosure text", () => {
    render(<AiDisclosureLabel />);
    expect(screen.getByTestId("ai-disclosure-label")).toHaveTextContent("AI assistant");
  });

  // The disclosure must be readable on every platform, including touch where
  // hover tooltips never appear. It is a plain visible text node, so it is
  // present without any interaction — no tooltip/hover gate.
  it("exposes the disclosure without requiring hover", () => {
    render(<AiDisclosureLabel />);
    expect(screen.getByText(/AI assistant/i)).toBeVisible();
  });
});
