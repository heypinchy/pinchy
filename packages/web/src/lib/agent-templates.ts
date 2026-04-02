import { getOdooToolsForAccessLevel } from "@/lib/tool-registry";

export interface OdooTemplateConfig {
  accessLevel: "read-only" | "read-write" | "full";
  requiredModels: Array<{
    model: string;
    operations: ("read" | "create" | "write" | "delete")[];
  }>;
}

export interface AgentTemplate {
  name: string;
  description: string;
  allowedTools: string[];
  pluginId: string | null;
  defaultPersonality: string;
  defaultTagline: string | null;
  defaultAgentsMd: string | null;
  requiresOdooConnection?: boolean;
  odooConfig?: OdooTemplateConfig;
}

export const AGENT_TEMPLATES: Record<string, AgentTemplate> = {
  "knowledge-base": {
    name: "Knowledge Base",
    description: "Answer questions from your docs",
    allowedTools: ["pinchy_ls", "pinchy_read"],
    pluginId: "pinchy-files",
    defaultPersonality: "the-professor",
    defaultTagline: "Answer questions from your docs",
    defaultAgentsMd: `You are a knowledge base agent. Your job is to answer questions using the documents available to you.

## Instructions
- Always cite the document name when referencing information
- If the documents don't contain an answer, say so clearly
- Prefer quoting relevant passages over paraphrasing
- Structure longer answers with headings and bullet points`,
  },
  custom: {
    name: "Custom Agent",
    description: "Start from scratch",
    allowedTools: [],
    pluginId: null,
    defaultPersonality: "the-butler",
    defaultTagline: null,
    defaultAgentsMd: null,
  },
  "odoo-sales-analyst": {
    name: "Sales Analyst",
    description: "Analyze revenue, track orders, identify trends and top customers",
    allowedTools: getOdooToolsForAccessLevel("read-only"),
    pluginId: null,
    defaultPersonality: "the-analyst",
    defaultTagline: "Analyze revenue, track orders, identify trends and top customers",
    defaultAgentsMd: null,
    requiresOdooConnection: true,
    odooConfig: {
      accessLevel: "read-only",
      requiredModels: [
        { model: "sale.order", operations: ["read"] },
        { model: "sale.order.line", operations: ["read"] },
        { model: "res.partner", operations: ["read"] },
        { model: "product.template", operations: ["read"] },
        { model: "product.product", operations: ["read"] },
      ],
    },
  },
  "odoo-inventory-scout": {
    name: "Inventory Scout",
    description: "Monitor stock levels, track movements, measure fulfillment speed",
    allowedTools: getOdooToolsForAccessLevel("read-only"),
    pluginId: null,
    defaultPersonality: "the-scout",
    defaultTagline: "Monitor stock levels, track movements, measure fulfillment speed",
    defaultAgentsMd: null,
    requiresOdooConnection: true,
    odooConfig: {
      accessLevel: "read-only",
      requiredModels: [
        { model: "stock.quant", operations: ["read"] },
        { model: "stock.move", operations: ["read"] },
        { model: "stock.move.line", operations: ["read"] },
        { model: "stock.picking", operations: ["read"] },
        { model: "product.product", operations: ["read"] },
        { model: "product.category", operations: ["read"] },
        { model: "stock.warehouse", operations: ["read"] },
        { model: "stock.location", operations: ["read"] },
      ],
    },
  },
  "odoo-finance-controller": {
    name: "Finance Controller",
    description: "Track invoices, monitor payments, analyze margins",
    allowedTools: getOdooToolsForAccessLevel("read-only"),
    pluginId: null,
    defaultPersonality: "the-controller",
    defaultTagline: "Track invoices, monitor payments, analyze margins",
    defaultAgentsMd: null,
    requiresOdooConnection: true,
    odooConfig: {
      accessLevel: "read-only",
      requiredModels: [
        { model: "account.move", operations: ["read"] },
        { model: "account.move.line", operations: ["read"] },
        { model: "account.payment", operations: ["read"] },
        { model: "account.analytic.line", operations: ["read"] },
        { model: "account.analytic.account", operations: ["read"] },
      ],
    },
  },
  "odoo-crm-assistant": {
    name: "CRM & Sales Assistant",
    description: "Manage leads, follow up on quotes, maintain customer data",
    allowedTools: getOdooToolsForAccessLevel("read-write"),
    pluginId: null,
    defaultPersonality: "the-closer",
    defaultTagline: "Manage leads, follow up on quotes, maintain customer data",
    defaultAgentsMd: null,
    requiresOdooConnection: true,
    odooConfig: {
      accessLevel: "read-write",
      requiredModels: [
        { model: "crm.lead", operations: ["read", "create", "write"] },
        { model: "crm.stage", operations: ["read"] },
        { model: "sale.order", operations: ["read", "create", "write"] },
        { model: "res.partner", operations: ["read", "create", "write"] },
        { model: "mail.message", operations: ["read", "create"] },
        { model: "mail.activity", operations: ["read", "create", "write"] },
      ],
    },
  },
  "odoo-procurement-agent": {
    name: "Procurement Agent",
    description: "Compare suppliers, track purchase prices, suggest reorders",
    allowedTools: getOdooToolsForAccessLevel("read-write"),
    pluginId: null,
    defaultPersonality: "the-buyer",
    defaultTagline: "Compare suppliers, track purchase prices, suggest reorders",
    defaultAgentsMd: null,
    requiresOdooConnection: true,
    odooConfig: {
      accessLevel: "read-write",
      requiredModels: [
        { model: "purchase.order", operations: ["read", "create", "write"] },
        { model: "purchase.order.line", operations: ["read", "create", "write"] },
        { model: "product.supplierinfo", operations: ["read", "create", "write"] },
        { model: "stock.quant", operations: ["read"] },
        { model: "res.partner", operations: ["read"] },
        { model: "product.product", operations: ["read"] },
      ],
    },
  },
  "odoo-customer-service": {
    name: "Customer Service",
    description: "Answer order inquiries, check delivery status, draft responses",
    allowedTools: getOdooToolsForAccessLevel("read-write"),
    pluginId: null,
    defaultPersonality: "the-concierge",
    defaultTagline: "Answer order inquiries, check delivery status, draft responses",
    defaultAgentsMd: null,
    requiresOdooConnection: true,
    odooConfig: {
      accessLevel: "read-write",
      requiredModels: [
        { model: "helpdesk.ticket", operations: ["read", "create", "write"] },
        { model: "sale.order", operations: ["read"] },
        { model: "stock.picking", operations: ["read"] },
        { model: "res.partner", operations: ["read"] },
        { model: "mail.message", operations: ["read", "create"] },
        { model: "mail.compose.message", operations: ["read", "create"] },
      ],
    },
  },
};

export function getTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES[id];
}

export function getTemplateList(): (AgentTemplate & { id: string })[] {
  return Object.entries(AGENT_TEMPLATES).map(([id, template]) => ({
    id,
    ...template,
  }));
}

/**
 * Generate the AGENTS.md content for an agent.
 *
 * For knowledge-base agents, dynamically includes the allowed paths and
 * explicit tool-use instructions so all models (including OpenAI) know
 * exactly where to look for files instead of guessing paths.
 */
export function generateAgentsMd(
  template: AgentTemplate,
  pluginConfig: { allowed_paths?: string[] } | undefined
): string | null {
  if (!template.defaultAgentsMd) return template.defaultAgentsMd;

  if (template.pluginId === "pinchy-files" && pluginConfig?.allowed_paths?.length) {
    const paths = pluginConfig.allowed_paths;
    const pathList = paths.map((p) => `- \`${p}\``).join("\n");
    return (
      template.defaultAgentsMd +
      `\n\n## File Access\nYour knowledge base is stored at:\n${pathList}\n\nTool use workflow:\n1. Always start with \`pinchy_ls\` on one of the paths above to discover available files\n2. Use \`pinchy_read\` to read specific files\n3. Never guess file names — always discover them first`
    );
  }

  return template.defaultAgentsMd;
}
