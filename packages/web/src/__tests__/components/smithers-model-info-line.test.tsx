// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SmithersModelInfoLine } from "@/components/setup/smithers-model-info-line";

describe("SmithersModelInfoLine", () => {
  it("displays the model display name and links to a page that exists", () => {
    // It linked to `/settings/agents` — a 404 — from the last screen of the
    // setup wizard, and this assertion pinned it there. `app-route-link-coverage`
    // is what makes that shape of green test impossible now.
    render(<SmithersModelInfoLine modelId="anthropic/claude-sonnet-4-6" />);
    expect(screen.getByText(/Claude Sonnet 4\.6/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Agents/i })).toHaveAttribute("href", "/agents");
  });

  it("renders with openai model id", () => {
    render(<SmithersModelInfoLine modelId="openai/gpt-5.5" />);
    expect(screen.getByText(/GPT 5\.5/i)).toBeInTheDocument();
  });

  it("renders with google model id", () => {
    render(<SmithersModelInfoLine modelId="google/gemini-2.5-pro" />);
    expect(screen.getByText(/Gemini 2.5 Pro/i)).toBeInTheDocument();
  });

  it("shows the informational text", () => {
    render(<SmithersModelInfoLine modelId="anthropic/claude-sonnet-4-6" />);
    expect(screen.getByText(/Smithers will use/i)).toBeInTheDocument();
    expect(screen.getByText(/You can change this in/i)).toBeInTheDocument();
  });
});
