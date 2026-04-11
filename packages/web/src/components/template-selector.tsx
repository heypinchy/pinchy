"use client";

import { Card, CardContent } from "@/components/ui/card";
import { ArrowRight, Bot } from "lucide-react";
import { OdooIcon } from "@/components/integration-icons";
import { groupTemplates, type TemplateItem } from "@/lib/template-grouping";
import { TEMPLATE_ICON_COMPONENTS } from "@/lib/template-icons";

interface TemplateSelectorProps {
  templates: TemplateItem[];
  onSelect: (templateId: string) => void;
}

const ICON_CLASS = "size-8 mb-2 text-muted-foreground";

function TemplateCard({
  template,
  onSelect,
}: {
  template: TemplateItem;
  onSelect: (id: string) => void;
}) {
  const isAvailable = template.available !== false;
  const IconComponent = template.iconName ? TEMPLATE_ICON_COMPONENTS[template.iconName] : Bot;

  return (
    <Card
      className={
        "cursor-pointer transition-colors" + (isAvailable ? " hover:border-primary" : " opacity-50")
      }
      onClick={() => onSelect(template.id)}
      data-available={isAvailable}
    >
      <CardContent className="flex flex-col items-center text-center p-6">
        <IconComponent className={ICON_CLASS} />
        <h3 className="font-semibold">{template.name}</h3>
        <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
      </CardContent>
    </Card>
  );
}

export function TemplateSelector({ templates, onSelect }: TemplateSelectorProps) {
  const { documents, odoo, custom } = groupTemplates(templates);

  return (
    <div className="space-y-8">
      {documents.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Documents</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {documents.map((template) => (
              <TemplateCard key={template.id} template={template} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}

      {odoo.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
            <OdooIcon className="h-4 w-auto" />
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {odoo.map((template) => (
              <TemplateCard key={template.id} template={template} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}

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
