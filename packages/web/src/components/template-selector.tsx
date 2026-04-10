"use client";

import { Card, CardContent } from "@/components/ui/card";
import { FileText, Bot } from "lucide-react";
import { OdooIcon } from "@/components/integration-icons";
import { groupTemplates, type TemplateItem } from "@/lib/template-grouping";

interface TemplateSelectorProps {
  templates: TemplateItem[];
  onSelect: (templateId: string) => void;
}

const TEMPLATE_ICONS: Record<string, React.ReactNode> = {
  "knowledge-base": <FileText className="size-8 mb-2 text-muted-foreground" />,
  custom: <Bot className="size-8 mb-2 text-muted-foreground" />,
};

function TemplateCard({
  template,
  icon,
  onSelect,
}: {
  template: TemplateItem;
  icon: React.ReactNode;
  onSelect: (id: string) => void;
}) {
  return (
    <Card
      className="cursor-pointer hover:border-primary transition-colors"
      onClick={() => onSelect(template.id)}
    >
      <CardContent className="flex flex-col items-center text-center p-6">
        {icon}
        <h3 className="font-semibold">{template.name}</h3>
        <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
      </CardContent>
    </Card>
  );
}

export function TemplateSelector({ templates, onSelect }: TemplateSelectorProps) {
  const { standard, odoo } = groupTemplates(templates);

  return (
    <div className="space-y-8">
      {standard.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Templates</h2>
          <div className="grid grid-cols-2 gap-4">
            {standard.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                icon={
                  TEMPLATE_ICONS[template.id] ?? (
                    <Bot className="size-8 mb-2 text-muted-foreground" />
                  )
                }
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      )}

      {odoo.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
            <OdooIcon className="h-4 w-auto" />
            Odoo
          </h2>
          <div className="grid grid-cols-3 gap-4">
            {odoo.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                icon={<OdooIcon className="h-8 w-auto mb-2 text-muted-foreground" />}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
