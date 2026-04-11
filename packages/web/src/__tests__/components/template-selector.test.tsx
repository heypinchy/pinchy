import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Bot } from "lucide-react";
import { isValidElement } from "react";
import { TemplateSelector, TEMPLATE_ICONS } from "@/components/template-selector";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";

describe("TemplateSelector", () => {
  const templates = [
    {
      id: "knowledge-base",
      name: "Knowledge Base",
      description: "Answer questions from your docs",
      requiresDirectories: true,
      available: true,
    },
    {
      id: "contract-analyzer",
      name: "Contract Analyzer",
      description: "Review and analyze contracts",
      requiresDirectories: true,
      available: true,
    },
    {
      id: "custom",
      name: "Custom Agent",
      description: "Start from scratch",
      requiresDirectories: false,
      available: true,
    },
  ];

  it("should render document templates in Documents section", () => {
    render(<TemplateSelector templates={templates} onSelect={vi.fn()} />);
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    expect(screen.getByText("Contract Analyzer")).toBeInTheDocument();
  });

  it("should render Custom Agent as standalone link, not as a card in the grid", () => {
    render(<TemplateSelector templates={templates} onSelect={vi.fn()} />);
    // Custom should appear as a text link/button, not inside the Documents grid
    const customLink = screen.getByText(/start from scratch/i);
    expect(customLink).toBeInTheDocument();
    // Should NOT be inside the Documents section grid
    const documentsHeading = screen.getByText("Documents");
    const documentsSection = documentsHeading.closest("div");
    expect(documentsSection).not.toContainElement(customLink);
  });

  it("should call onSelect with 'custom' when clicking the standalone custom link", () => {
    const onSelect = vi.fn();
    render(<TemplateSelector templates={templates} onSelect={onSelect} />);
    fireEvent.click(screen.getByText(/start from scratch/i));
    expect(onSelect).toHaveBeenCalledWith("custom");
  });

  it("should call onSelect when a document template is clicked", () => {
    const onSelect = vi.fn();
    render(<TemplateSelector templates={templates} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Knowledge Base"));
    expect(onSelect).toHaveBeenCalledWith("knowledge-base");
  });

  it("should show template descriptions", () => {
    render(<TemplateSelector templates={templates} onSelect={vi.fn()} />);
    expect(screen.getByText("Answer questions from your docs")).toBeInTheDocument();
  });

  it("should render Odoo section when Odoo templates exist", () => {
    const withOdoo = [
      ...templates,
      {
        id: "odoo-sales-analyst",
        name: "Sales Analyst",
        description: "Analyze revenue",
        requiresDirectories: false,
        requiresOdooConnection: true,
        available: true,
      },
    ];

    render(<TemplateSelector templates={withOdoo} onSelect={vi.fn()} />);
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("Sales Analyst")).toBeInTheDocument();
  });

  it("should dim unavailable templates with reduced opacity", () => {
    const mixedTemplates = [
      {
        id: "odoo-available",
        name: "Available Agent",
        description: "Works fine",
        requiresOdooConnection: true,
        requiresDirectories: false,
        available: true,
      },
      {
        id: "odoo-unavailable",
        name: "Unavailable Agent",
        description: "Missing modules",
        requiresOdooConnection: true,
        requiresDirectories: false,
        available: false,
      },
    ];

    render(<TemplateSelector templates={mixedTemplates} onSelect={vi.fn()} />);

    const availableCard = screen.getByText("Available Agent").closest("[data-available]");
    const unavailableCard = screen.getByText("Unavailable Agent").closest("[data-available]");

    expect(availableCard).toHaveAttribute("data-available", "true");
    expect(unavailableCard).toHaveAttribute("data-available", "false");
  });

  it("should have a dedicated non-fallback icon for every Odoo template in AGENT_TEMPLATES", () => {
    const odooTemplateIds = Object.keys(AGENT_TEMPLATES).filter((id) => id.startsWith("odoo-"));

    // Every Odoo template must have an entry in TEMPLATE_ICONS...
    const missingIcons = odooTemplateIds.filter((id) => !TEMPLATE_ICONS[id]);
    expect(missingIcons).toEqual([]);

    // ...and the entry must NOT be the generic Bot fallback. Using Bot here is
    // indistinguishable from "no icon" in the UI and defeats the purpose of
    // the mapping — catch it explicitly.
    const usingBotFallback = odooTemplateIds.filter((id) => {
      const icon = TEMPLATE_ICONS[id];
      return isValidElement(icon) && icon.type === Bot;
    });
    expect(usingBotFallback).toEqual([]);
  });

  it("should still call onSelect for unavailable templates", () => {
    const onSelect = vi.fn();
    const mixedTemplates = [
      {
        id: "odoo-unavailable",
        name: "Unavailable Agent",
        description: "Missing modules",
        requiresOdooConnection: true,
        requiresDirectories: false,
        available: false,
      },
    ];

    render(<TemplateSelector templates={mixedTemplates} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Unavailable Agent"));
    expect(onSelect).toHaveBeenCalledWith("odoo-unavailable");
  });
});
