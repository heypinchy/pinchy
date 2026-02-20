import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TemplateSelector } from "@/components/template-selector";

describe("TemplateSelector", () => {
  const templates = [
    {
      id: "knowledge-base",
      name: "Knowledge Base",
      description: "Answer questions from your docs",
    },
    {
      id: "custom",
      name: "Custom Agent",
      description: "Start from scratch",
    },
  ];

  it("should render all templates", () => {
    render(<TemplateSelector templates={templates} onSelect={vi.fn()} />);
    expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    expect(screen.getByText("Custom Agent")).toBeInTheDocument();
  });

  it("should call onSelect when a template is clicked", () => {
    const onSelect = vi.fn();
    render(<TemplateSelector templates={templates} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Knowledge Base"));
    expect(onSelect).toHaveBeenCalledWith("knowledge-base");
  });

  it("should show template descriptions", () => {
    render(<TemplateSelector templates={templates} onSelect={vi.fn()} />);
    expect(screen.getByText("Answer questions from your docs")).toBeInTheDocument();
  });
});
