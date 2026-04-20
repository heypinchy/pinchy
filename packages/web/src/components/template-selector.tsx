"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowRight, Bot, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  groupTemplatesByCategory,
  getAccessBadgeProps,
  type TemplateItem,
} from "@/lib/template-grouping";
import { TEMPLATE_ICON_COMPONENTS } from "@/lib/template-icons";

interface TemplateSelectorProps {
  templates: TemplateItem[];
  onSelect: (templateId: string) => void;
}

function TemplateCard({
  template,
  onSelect,
}: {
  template: TemplateItem;
  onSelect: (id: string) => void;
}) {
  const IconComponent = template.iconName ? TEMPLATE_ICON_COMPONENTS[template.iconName] : Bot;
  const badge = getAccessBadgeProps(template);
  const isDisabled = template.disabled === true;

  const card = (
    <Card
      role="button"
      tabIndex={0}
      aria-disabled={isDisabled ? "true" : undefined}
      className={cn(
        "transition-colors",
        isDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:border-primary"
      )}
      onClick={isDisabled ? undefined : () => onSelect(template.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === " ") e.preventDefault();
      }}
      onKeyUp={(e) => {
        if (e.target !== e.currentTarget) return;
        if (!isDisabled && (e.key === "Enter" || e.key === " ")) onSelect(template.id);
      }}
    >
      <CardContent className="flex flex-col items-center text-center p-4">
        <IconComponent className="size-6 mb-1 text-muted-foreground" />
        <h3 className="font-semibold">{template.name}</h3>
        <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
        {badge && <span className="mt-2 text-[11px] text-muted-foreground">{badge.label}</span>}
      </CardContent>
    </Card>
  );

  if (isDisabled && template.disabledReason) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{card}</TooltipTrigger>
          <TooltipContent>{template.disabledReason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return card;
}

function UnavailableTriggerText({ templates }: { templates: TemplateItem[] }) {
  const hasNoConnection = templates.some((t) => t.unavailableReason === "no-connection");
  if (hasNoConnection) {
    return (
      <>
        {templates.length} templates available with Odoo ·{" "}
        <Link href="/settings?tab=integrations" className="underline hover:text-foreground">
          Set up connection →
        </Link>
      </>
    );
  }
  return <>{templates.length} more with additional Odoo modules</>;
}

export function TemplateSelector({ templates, onSelect }: TemplateSelectorProps) {
  const { categories, custom } = groupTemplatesByCategory(templates);

  return (
    <div className="space-y-8">
      {categories.map((category) => {
        const available = category.templates.filter((t) => t.available !== false);
        const unavailable = category.templates.filter((t) => t.available === false);

        return (
          <div key={category.id}>
            <h2 className="text-base font-semibold mb-3">{category.label}</h2>
            {available.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {available.map((template) => (
                  <TemplateCard key={template.id} template={template} onSelect={onSelect} />
                ))}
              </div>
            )}
            {unavailable.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mt-3 cursor-pointer">
                  <ChevronRight className="size-4" />
                  <UnavailableTriggerText templates={unavailable} />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-3">
                    {unavailable.map((template) => (
                      <TemplateCard key={template.id} template={template} onSelect={onSelect} />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        );
      })}

      {custom && (
        <div className="border-t pt-6">
          <button
            type="button"
            onClick={() => onSelect(custom.id)}
            className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            Or start from scratch
            <ArrowRight className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
