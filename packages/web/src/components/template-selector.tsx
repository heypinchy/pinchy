"use client";

import { Card, CardContent } from "@/components/ui/card";
import {
  FileText,
  Bot,
  TrendingUp,
  Warehouse,
  Calculator,
  Handshake,
  ShoppingCart,
  Headset,
  Scale,
  Users,
  GitCompareArrows,
  ShieldCheck,
  GraduationCap,
  ArrowRight,
  UserCog,
  FolderKanban,
  Factory,
  UserSearch,
  Repeat,
  Store,
  Megaphone,
  Receipt,
  Car,
  Globe,
} from "lucide-react";
import { OdooIcon } from "@/components/integration-icons";
import { groupTemplates, type TemplateItem } from "@/lib/template-grouping";

interface TemplateSelectorProps {
  templates: TemplateItem[];
  onSelect: (templateId: string) => void;
}

const ICON_CLASS = "size-8 mb-2 text-muted-foreground";

export const TEMPLATE_ICONS: Record<string, React.ReactNode> = {
  "knowledge-base": <FileText className={ICON_CLASS} />,
  "contract-analyzer": <Scale className={ICON_CLASS} />,
  "resume-screener": <Users className={ICON_CLASS} />,
  "proposal-comparator": <GitCompareArrows className={ICON_CLASS} />,
  "compliance-checker": <ShieldCheck className={ICON_CLASS} />,
  "onboarding-guide": <GraduationCap className={ICON_CLASS} />,
  "odoo-sales-analyst": <TrendingUp className={ICON_CLASS} />,
  "odoo-inventory-scout": <Warehouse className={ICON_CLASS} />,
  "odoo-finance-controller": <Calculator className={ICON_CLASS} />,
  "odoo-crm-assistant": <Handshake className={ICON_CLASS} />,
  "odoo-procurement-agent": <ShoppingCart className={ICON_CLASS} />,
  "odoo-customer-service": <Headset className={ICON_CLASS} />,
  "odoo-hr-analyst": <UserCog className={ICON_CLASS} />,
  "odoo-project-tracker": <FolderKanban className={ICON_CLASS} />,
  "odoo-manufacturing-planner": <Factory className={ICON_CLASS} />,
  "odoo-recruitment-coordinator": <UserSearch className={ICON_CLASS} />,
  "odoo-subscription-manager": <Repeat className={ICON_CLASS} />,
  "odoo-pos-analyst": <Store className={ICON_CLASS} />,
  "odoo-marketing-analyst": <Megaphone className={ICON_CLASS} />,
  "odoo-expense-auditor": <Receipt className={ICON_CLASS} />,
  "odoo-fleet-manager": <Car className={ICON_CLASS} />,
  "odoo-website-analyst": <Globe className={ICON_CLASS} />,
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
  const isAvailable = template.available !== false;

  return (
    <Card
      className={
        "cursor-pointer transition-colors" + (isAvailable ? " hover:border-primary" : " opacity-50")
      }
      onClick={() => onSelect(template.id)}
      data-available={isAvailable}
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
  const { documents, odoo, custom } = groupTemplates(templates);

  return (
    <div className="space-y-8">
      {documents.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Documents</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {documents.map((template) => (
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
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {odoo.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                icon={TEMPLATE_ICONS[template.id] ?? <Bot className={ICON_CLASS} />}
                onSelect={onSelect}
              />
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
