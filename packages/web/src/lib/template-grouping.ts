export interface TemplateItem {
  id: string;
  name: string;
  description: string;
  requiresDirectories: boolean;
  requiresOdooConnection?: boolean;
  odooAccessLevel?: string;
  defaultTagline: string | null;
  available?: boolean;
}

export interface GroupedTemplates {
  documents: TemplateItem[];
  odoo: TemplateItem[];
  custom: TemplateItem | null;
}

export function groupTemplates(templates: TemplateItem[]): GroupedTemplates {
  const documents: TemplateItem[] = [];
  const odoo: TemplateItem[] = [];
  let custom: TemplateItem | null = null;

  for (const template of templates) {
    if (template.id === "custom") {
      custom = template;
    } else if (template.requiresOdooConnection) {
      odoo.push(template);
    } else {
      documents.push(template);
    }
  }

  // Sort: available templates first
  odoo.sort((a, b) => {
    const aAvail = a.available !== false ? 1 : 0;
    const bAvail = b.available !== false ? 1 : 0;
    return bAvail - aAvail;
  });

  return { documents, odoo, custom };
}
