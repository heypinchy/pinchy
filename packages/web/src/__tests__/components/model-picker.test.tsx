import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom";
import { ModelPicker } from "@/components/model-picker";

const providers = [
  {
    id: "anthropic",
    name: "Anthropic",
    models: [
      { id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7" },
      { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    ],
  },
];

describe("ModelPicker", () => {
  it("renders with the current selected model name visible", () => {
    render(
      <ModelPicker value="anthropic/claude-opus-4-7" onChange={() => {}} providers={providers} />
    );
    expect(screen.getByText("Claude Opus 4.7")).toBeInTheDocument();
  });
});
