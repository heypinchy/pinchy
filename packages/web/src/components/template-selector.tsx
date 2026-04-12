"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowRight, Bot } from "lucide-react";
import {
  groupTemplatesByCategory,
  getAccessBadgeProps,
  type TemplateItem,
  type TemplateCategory,
} from "@/lib/template-grouping";
import { TEMPLATE_ICON_COMPONENTS } from "@/lib/template-icons";

interface TemplateSelectorProps {
  templates: TemplateItem[];
  onSelect: (templateId: string) => void;
}

const ICON_CLASS = "size-8 mb-2 text-muted-foreground";

const BADGE_COLORS = {
  green:
    "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 border-green-200 dark:border-green-800",
  amber:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200 border-yellow-200 dark:border-yellow-800",
  red: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 border-red-200 dark:border-red-800",
};

function TemplateCard({
  template,
  onSelect,
}: {
  template: TemplateItem;
  onSelect: (id: string) => void;
}) {
  const isAvailable = template.available !== false;
  const IconComponent = template.iconName ? TEMPLATE_ICON_COMPONENTS[template.iconName] : Bot;
  const badge = getAccessBadgeProps(template);

  return (
    <Card
      role="button"
      tabIndex={0}
      className={
        "cursor-pointer transition-colors" + (isAvailable ? " hover:border-primary" : " opacity-50")
      }
      onClick={() => onSelect(template.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === " ") e.preventDefault();
      }}
      onKeyUp={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") onSelect(template.id);
      }}
      data-available={isAvailable}
    >
      <CardContent className="flex flex-col items-center text-center p-6">
        <IconComponent className={ICON_CLASS} />
        <h3 className="font-semibold">{template.name}</h3>
        <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
        {badge && (
          <span
            className={`mt-3 inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${BADGE_COLORS[badge.variant]}`}
          >
            {badge.label}
          </span>
        )}
      </CardContent>
    </Card>
  );
}

function CategoryTeaser({ category }: { category: TemplateCategory }) {
  const count = category.templates.length;
  return (
    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
      {count} templates available with Odoo ·{" "}
      <Link href="/settings?tab=integrations" className="underline hover:text-foreground">
        Set up connection →
      </Link>
    </div>
  );
}

export function TemplateSelector({ templates, onSelect }: TemplateSelectorProps) {
  const { categories, custom } = groupTemplatesByCategory(templates);

  return (
    <div className="space-y-8">
      {categories.map((category) => {
        const allUnavailable = category.templates.every((t) => t.available === false);

        return (
          <div key={category.id}>
            <h2 className="text-sm font-medium text-muted-foreground mb-3">{category.label}</h2>
            {allUnavailable ? (
              <CategoryTeaser category={category} />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {category.templates.map((template) => (
                  <TemplateCard key={template.id} template={template} onSelect={onSelect} />
                ))}
              </div>
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
