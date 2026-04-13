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

  it("should call onSelect when Enter is pressed on a template card", () => {
    const onSelect = vi.fn();
    render(<TemplateSelector templates={templates} onSelect={onSelect} />);
    const card = screen.getByText("Knowledge Base").closest("[role='button']")!;
    fireEvent.keyUp(card, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("knowledge-base");
  });

  it("should call onSelect when Space is pressed on a template card", () => {
    const onSelect = vi.fn();
    render(<TemplateSelector templates={templates} onSelect={onSelect} />);
    const card = screen.getByText("Knowledge Base").closest("[role='button']")!;
    fireEvent.keyUp(card, { key: " " });
    expect(onSelect).toHaveBeenCalledWith("knowledge-base");
  });

  it("template cards are focusable via tabIndex", () => {
    render(<TemplateSelector templates={templates} onSelect={vi.fn()} />);
    const card = screen.getByText("Knowledge Base").closest("[role='button']")!;
    expect(card).toHaveAttribute("tabindex", "0");
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

  it("hides unavailable templates behind collapsible trigger", () => {
    const mixedTemplates = [
      {
        id: "odoo-sales-analyst",
        name: "Sales Analyst",
        description: "Analyze revenue",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-only",
        available: true,
      },
      {
        id: "odoo-crm-assistant",
        name: "CRM Assistant",
        description: "Manage leads",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-write",
        available: false,
        unavailableReason: "missing-modules" as const,
      },
      {
        id: "odoo-customer-service",
        name: "Customer Service",
        description: "Handle support",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-only",
        available: false,
        unavailableReason: "missing-modules" as const,
      },
    ];

    render(<TemplateSelector templates={mixedTemplates} onSelect={vi.fn()} />);
    // Available template visible
    expect(screen.getByText("Sales Analyst")).toBeInTheDocument();
    // Unavailable templates hidden
    expect(screen.queryByText("CRM Assistant")).not.toBeInTheDocument();
    // Trigger shows count
    expect(screen.getByText(/2 more with additional Odoo modules/)).toBeInTheDocument();
  });

  it("shows 'Set up connection' trigger when unavailable reason is no-connection", () => {
    const noConnTemplates = [
      {
        id: "odoo-sales-analyst",
        name: "Sales Analyst",
        description: "Analyze revenue",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-only",
        available: false,
        unavailableReason: "no-connection" as const,
      },
      {
        id: "odoo-crm-assistant",
        name: "CRM Assistant",
        description: "Manage leads",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-write",
        available: false,
        unavailableReason: "no-connection" as const,
      },
    ];

    render(<TemplateSelector templates={noConnTemplates} onSelect={vi.fn()} />);
    expect(screen.getByText(/2 templates available with Odoo/)).toBeInTheDocument();
    const link = screen.getByText(/Set up connection/);
    expect(link).toBeInTheDocument();
    expect(link.closest("a")).toHaveAttribute("href", "/settings?tab=integrations");
  });

  it("expands to show unavailable template cards on trigger click", () => {
    const mixedTemplates = [
      {
        id: "odoo-sales-analyst",
        name: "Sales Analyst",
        description: "Analyze revenue",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-only",
        available: true,
      },
      {
        id: "odoo-crm-assistant",
        name: "CRM Assistant",
        description: "Manage leads",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-write",
        available: false,
        unavailableReason: "missing-modules" as const,
      },
    ];

    render(<TemplateSelector templates={mixedTemplates} onSelect={vi.fn()} />);
    // Initially hidden
    expect(screen.queryByText("CRM Assistant")).not.toBeInTheDocument();

    // Click trigger to expand
    fireEvent.click(screen.getByText(/1 more with additional Odoo modules/));

    // Now visible
    expect(screen.getByText("CRM Assistant")).toBeInTheDocument();
  });

  it("shows all templates in collapsible when entire category is unavailable", () => {
    const allUnavailable = [
      {
        id: "odoo-sales-analyst",
        name: "Sales Analyst",
        description: "Analyze revenue",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-only",
        available: false,
        unavailableReason: "missing-modules" as const,
      },
      {
        id: "odoo-crm-assistant",
        name: "CRM Assistant",
        description: "Manage leads",
        requiresOdooConnection: true,
        requiresDirectories: false,
        odooAccessLevel: "read-write",
        available: false,
        unavailableReason: "missing-modules" as const,
      },
    ];

    render(<TemplateSelector templates={allUnavailable} onSelect={vi.fn()} />);
    // Category heading visible
    expect(screen.getByText("Sales & Customers")).toBeInTheDocument();
    // Templates hidden behind trigger
    expect(screen.queryByText("Sales Analyst")).not.toBeInTheDocument();
    expect(screen.getByText(/2 more with additional Odoo modules/)).toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByText(/2 more with additional Odoo modules/));
    expect(screen.getByText("Sales Analyst")).toBeInTheDocument();
    expect(screen.getByText("CRM Assistant")).toBeInTheDocument();
  });

  it("should call onSelect for unavailable templates after expanding", () => {
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
        unavailableReason: "missing-modules" as const,
      },
    ];

    render(<TemplateSelector templates={mixedTemplates} onSelect={onSelect} />);
    // Expand first
    fireEvent.click(screen.getByText(/1 more with additional Odoo modules/));
    // Then click the unavailable template
    fireEvent.click(screen.getByText("Unavailable Agent"));
    expect(onSelect).toHaveBeenCalledWith("odoo-crm-assistant");
  });
});
