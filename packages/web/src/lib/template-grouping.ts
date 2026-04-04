export interface TemplateItem {
  id: string;
  name: string;
  description: string;
  requiresDirectories: boolean;
  requiresOdooConnection?: boolean;
  odooAccessLevel?: string;
  defaultTagline: string | null;
}

export interface GroupedTemplates {
  standard: TemplateItem[];
  odoo: TemplateItem[];
}

export function groupTemplates(templates: TemplateItem[]): GroupedTemplates {
  const standard: TemplateItem[] = [];
  const odoo: TemplateItem[] = [];

  for (const template of templates) {
    if (template.requiresOdooConnection) {
      odoo.push(template);
    } else {
      standard.push(template);
    }
  }

  return { standard, odoo };
}
