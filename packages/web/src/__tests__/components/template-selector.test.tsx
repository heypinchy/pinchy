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

  it("renders templates in thematic categories", () => {
    render(<TemplateSelector templates={templates} onSelect={vi.fn()} />);
    expect(screen.getByText("Knowledge & Compliance")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    expect(screen.getByText("Contract Analyzer")).toBeInTheDocument();
  });

  it("renders Custom Agent as standalone link, not in any category", () => {
    render(<TemplateSelector templates={templates} onSelect={vi.fn()} />);
    const customLink = screen.getByText(/start from scratch/i);
    expect(customLink).toBeInTheDocument();
    const categoryHeading = screen.getByText("Knowledge & Compliance");
    const categorySection = categoryHeading.closest("div");
    expect(categorySection).not.toContainElement(customLink);
  });

  it("should call onSelect with 'custom' when clicking the standalone custom link", () => {
    const onSelect = vi.fn();
    render(<TemplateSelector templates={templates} onSelect={onSelect} />);
    fireEvent.click(screen.getByText(/start from scratch/i));
    expect(onSelect).toHaveBeenCalledWith("custom");
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

  it("renders Odoo template in its thematic category, not in separate Odoo section", () => {
    const withOdoo = [
      ...templates,
      {
        id: "odoo-sales-analyst",
        name: "Sales Analyst",
        description: "Analyze revenue",
        requiresDirectories: false,
        requiresOdooConnection: true,
        odooAccessLevel: "read-only",
        available: true,
      },
    ];

    render(<TemplateSelector templates={withOdoo} onSelect={vi.fn()} />);
    expect(screen.getByText("Sales & Customers")).toBeInTheDocument();
    expect(screen.getByText("Sales Analyst")).toBeInTheDocument();
    expect(screen.queryByText("Documents")).not.toBeInTheDocument();
  });

  it("renders access badge on read-only Odoo template card", () => {
    const odooTemplates = [
      {
        id: "odoo-sales-analyst",
        name: "Sales Analyst",
        description: "Analyze revenue",
        requiresDirectories: false,
        requiresOdooConnection: true,
        odooAccessLevel: "read-only",
        available: true,
      },
    ];

    render(<TemplateSelector templates={odooTemplates} onSelect={vi.fn()} />);
    expect(screen.getByText("Odoo · Read-only")).toBeInTheDocument();
  });

  it("renders access badge on read-write Odoo template card", () => {
    const odooTemplates = [
      {
        id: "odoo-crm-assistant",
        name: "CRM Assistant",
        description: "Manage leads",
        requiresDirectories: false,
        requiresOdooConnection: true,
        odooAccessLevel: "read-write",
        available: true,
      },
    ];

    render(<TemplateSelector templates={odooTemplates} onSelect={vi.fn()} />);
    expect(screen.getByText("Odoo · Read & Write")).toBeInTheDocument();
  });

  it("renders access badge on documents template card", () => {
    const docTemplates = [
      {
        id: "knowledge-base",
        name: "Knowledge Base",
        description: "Answer questions",
        requiresDirectories: true,
        available: true,
      },
    ];

    render(<TemplateSelector templates={docTemplates} onSelect={vi.fn()} />);
    expect(screen.getByText("Documents · Read-only")).toBeInTheDocument();
  });

  it("shows teaser when all category templates are unavailable", () => {
    const unavailableTemplates = [
      {
        id: "odoo-sales-analyst",
        name: "Sales Analyst",
        description: "Analyze revenue",
        requiresDirectories: false,
        requiresOdooConnection: true,
        odooAccessLevel: "read-only",
        available: false,
      },
      {
        id: "odoo-crm-assistant",
        name: "CRM Assistant",
        description: "Manage leads",
        requiresDirectories: false,
        requiresOdooConnection: true,
        odooAccessLevel: "read-write",
        available: false,
      },
    ];

    render(<TemplateSelector templates={unavailableTemplates} onSelect={vi.fn()} />);
    expect(screen.getByText(/2 templates available with Odoo/)).toBeInTheDocument();
    const link = screen.getByText(/Set up connection/);
    expect(link).toBeInTheDocument();
    expect(link.closest("a")).toHaveAttribute("href", "/settings?tab=integrations");
  });

  it("should dim unavailable templates with reduced opacity", () => {
    const mixedTemplates = [
      {
        id: "odoo-sales-analyst",
        name: "Available Agent",
        description: "Works fine",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-only",
        available: true,
      },
      {
        id: "odoo-crm-assistant",
        name: "Unavailable Agent",
        description: "Missing modules",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-write",
        available: false,
      },
    ];

    render(<TemplateSelector templates={mixedTemplates} onSelect={vi.fn()} />);

    const availableCard = screen.getByText("Available Agent").closest("[data-available]");
    const unavailableCard = screen.getByText("Unavailable Agent").closest("[data-available]");

    expect(availableCard).toHaveAttribute("data-available", "true");
    expect(unavailableCard).toHaveAttribute("data-available", "false");
  });

  it("should still call onSelect for unavailable templates in mixed categories", () => {
    const onSelect = vi.fn();
    const mixedTemplates = [
      {
        id: "odoo-sales-analyst",
        name: "Available Agent",
        description: "Works",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-only",
        available: true,
      },
      {
        id: "odoo-crm-assistant",
        name: "Unavailable Agent",
        description: "Missing modules",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-write",
        available: false,
      },
    ];

    render(<TemplateSelector templates={mixedTemplates} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Unavailable Agent"));
    expect(onSelect).toHaveBeenCalledWith("odoo-crm-assistant");
  });
});
