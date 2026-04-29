import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TemplateSelector } from "@/components/template-selector";
import type { TemplateItem } from "@/lib/template-grouping";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/template-icons", () => ({
  TEMPLATE_ICON_COMPONENTS: {},
}));

// Render tooltip content inline so we can assert text without Radix Portal mechanics
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));

const knowledgeBaseTemplate = (overrides: Partial<TemplateItem> = {}): TemplateItem => ({
  id: "knowledge-base",
  name: "Knowledge Base",
  description: "Answer questions from your docs",
  requiresDirectories: true,
  requiresOdooConnection: false,
  defaultTagline: "Answer questions from your docs",
  available: true,
  disabled: false,
  ...overrides,
});

describe("TemplateSelector disabled state", () => {
  it("calls onSelect when clicking an enabled card", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<TemplateSelector templates={[knowledgeBaseTemplate()]} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /Knowledge Base/i }));
    expect(onSelect).toHaveBeenCalledWith("knowledge-base");
  });

  it("does not call onSelect when clicking a disabled card", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <TemplateSelector
        templates={[
          knowledgeBaseTemplate({
            disabled: true,
            disabledReason: "Requires vision. Your provider has no matching model.",
          }),
        ]}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByRole("button", { name: /Knowledge Base/i }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks disabled card with aria-disabled", () => {
    const onSelect = vi.fn();

    render(
      <TemplateSelector
        templates={[
          knowledgeBaseTemplate({
            disabled: true,
            disabledReason: "Requires vision. Your provider has no matching model.",
          }),
        ]}
        onSelect={onSelect}
      />
    );

    expect(screen.getByRole("button", { name: /Knowledge Base/i })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("shows disabledReason in tooltip for disabled card", () => {
    const onSelect = vi.fn();

    render(
      <TemplateSelector
        templates={[
          knowledgeBaseTemplate({
            disabled: true,
            disabledReason: "Requires vision. Your provider has no matching model.",
          }),
        ]}
        onSelect={onSelect}
      />
    );

    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Requires vision. Your provider has no matching model."
    );
  });

  it("does not render a tooltip for enabled cards", () => {
    const onSelect = vi.fn();

    render(<TemplateSelector templates={[knowledgeBaseTemplate()]} onSelect={onSelect} />);

    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
