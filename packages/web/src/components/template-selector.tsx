"use client";

import { Card, CardContent } from "@/components/ui/card";
import { FileText, Bot } from "lucide-react";

interface Template {
  id: string;
  name: string;
  description: string;
}

interface TemplateSelectorProps {
  templates: Template[];
  onSelect: (templateId: string) => void;
}

const TEMPLATE_ICONS: Record<string, React.ReactNode> = {
  "knowledge-base": <FileText className="h-8 w-8 mb-2 text-muted-foreground" />,
  custom: <Bot className="h-8 w-8 mb-2 text-muted-foreground" />,
};

export function TemplateSelector({ templates, onSelect }: TemplateSelectorProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      {templates.map((template) => (
        <Card
          key={template.id}
          className="cursor-pointer hover:border-primary transition-colors"
          onClick={() => onSelect(template.id)}
        >
          <CardContent className="flex flex-col items-center text-center p-6">
            {TEMPLATE_ICONS[template.id] ?? <Bot className="h-8 w-8 mb-2 text-muted-foreground" />}
            <h3 className="font-semibold">{template.name}</h3>
            <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
