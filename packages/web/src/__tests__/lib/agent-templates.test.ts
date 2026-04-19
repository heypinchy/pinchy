import { describe, it, expect } from "vitest";
import {
  AGENT_TEMPLATES,
  createOdooTemplate,
  deriveOdooAccessLevel,
  getTemplate,
  getTemplateList,
  generateAgentsMd,
  pickSuggestedName,
} from "@/lib/agent-templates";
import { PERSONALITY_PRESETS } from "@/lib/personality-presets";
import { TEMPLATE_ICON_COMPONENTS } from "@/lib/template-icons";
import { getOdooToolsForAccessLevel } from "@/lib/tool-registry";

describe("agent-templates", () => {
  it("should have a knowledge-base template", () => {
    expect(AGENT_TEMPLATES["knowledge-base"]).toBeDefined();
    expect(AGENT_TEMPLATES["knowledge-base"].name).toBe("Knowledge Base");
    expect(AGENT_TEMPLATES["knowledge-base"].pluginId).toBe("pinchy-files");
    expect(AGENT_TEMPLATES["knowledge-base"].allowedTools).toEqual(["pinchy_ls", "pinchy_read"]);
  });

  it("should have a custom template with no allowed tools", () => {
    expect(AGENT_TEMPLATES["custom"]).toBeDefined();
    expect(AGENT_TEMPLATES["custom"].pluginId).toBeNull();
    expect(AGENT_TEMPLATES["custom"].allowedTools).toEqual([]);
  });

  it("should return template by id", () => {
    expect(getTemplate("knowledge-base")).toBe(AGENT_TEMPLATES["knowledge-base"]);
  });

  it("should return undefined for unknown template", () => {
    expect(getTemplate("nonexistent")).toBeUndefined();
  });

  it("knowledge-base should use the-professor personality", () => {
    expect(AGENT_TEMPLATES["knowledge-base"].defaultPersonality).toBe("the-professor");
  });

  it("custom should use the-butler personality", () => {
    expect(AGENT_TEMPLATES["custom"].defaultPersonality).toBe("the-butler");
  });

  it("every non-custom template declares an iconName", () => {
    // Icons used to live in a separate map in template-selector.tsx, which
    // made it possible to ship a template without a matching icon entry. The
    // iconName field co-locates the icon with the template definition so TSC
    // enforces presence of the mapping.
    const missing: string[] = [];
    for (const [id, template] of Object.entries(AGENT_TEMPLATES)) {
      if (id === "custom") continue;
      if (!template.iconName) {
        missing.push(id);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every template's iconName resolves to a real lucide icon component", () => {
    const unresolved: Array<{ id: string; iconName: string }> = [];
    for (const [id, template] of Object.entries(AGENT_TEMPLATES)) {
      if (!template.iconName) continue;
      if (!TEMPLATE_ICON_COMPONENTS[template.iconName]) {
        unresolved.push({ id, iconName: template.iconName });
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("every Odoo template has a dedicated non-Bot icon", () => {
    // Bot is the universal fallback — it means "no icon assigned". Catching
    // Bot here prevents a new Odoo template from silently inheriting the
    // generic bot avatar in the selector grid.
    const odooIds = Object.keys(AGENT_TEMPLATES).filter((id) => id.startsWith("odoo-"));
    const botFallback = odooIds.filter((id) => AGENT_TEMPLATES[id].iconName === "Bot");
    expect(botFallback).toEqual([]);
  });

  it("every template's defaultPersonality references an existing preset", () => {
    // Structural invariant: no template can ship with a typo'd personality id.
    // The type system enforces this at compile time, but the runtime check
    // catches drift if someone adds a raw-string template, and gives a clear
    // error message pointing at the offending template.
    const invalid: Array<{ id: string; personality: string }> = [];
    for (const [id, tpl] of Object.entries(AGENT_TEMPLATES)) {
      if (!PERSONALITY_PRESETS[tpl.defaultPersonality]) {
        invalid.push({ id, personality: tpl.defaultPersonality });
      }
    }
    expect(invalid).toEqual([]);
  });

  it("knowledge-base should have a defaultTagline", () => {
    expect(AGENT_TEMPLATES["knowledge-base"].defaultTagline).toBe(
      "Answer questions from your docs"
    );
  });

  it("custom should have null defaultTagline", () => {
    expect(AGENT_TEMPLATES["custom"].defaultTagline).toBeNull();
  });

  it("should not have old defaultSoulMd or defaultGreeting fields", () => {
    const kb = AGENT_TEMPLATES["knowledge-base"] as Record<string, unknown>;
    expect(kb.defaultSoulMd).toBeUndefined();
    expect(kb.defaultGreeting).toBeUndefined();
  });

  it("all templates should have defaultAgentsMd field", () => {
    for (const template of Object.values(AGENT_TEMPLATES)) {
      expect(template).toHaveProperty("defaultAgentsMd");
    }
  });

  it("knowledge-base should have non-null defaultAgentsMd with document-answering instructions", () => {
    const kb = AGENT_TEMPLATES["knowledge-base"];
    expect(kb.defaultAgentsMd).not.toBeNull();
    expect(kb.defaultAgentsMd).toContain("knowledge base agent");
    expect(kb.defaultAgentsMd).toContain("cite");
  });

  it("custom should have null defaultAgentsMd", () => {
    expect(AGENT_TEMPLATES["custom"].defaultAgentsMd).toBeNull();
  });
});

describe("generateAgentsMd", () => {
  it("should include allowed paths for knowledge-base template", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, { allowed_paths: ["/data/hr-docs/"] });
    expect(content).toContain("/data/hr-docs/");
  });

  it("should instruct the agent to use pinchy_ls before reading files", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, { allowed_paths: ["/data/hr-docs/"] });
    expect(content).toContain("pinchy_ls");
  });

  it("should preserve the base knowledge base instructions", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, { allowed_paths: ["/data/hr-docs/"] });
    expect(content).toContain("knowledge base agent");
    expect(content).toContain("cite");
  });

  it("should include all provided paths when multiple paths given", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, { allowed_paths: ["/data/docs/", "/data/hr/"] });
    expect(content).toContain("/data/docs/");
    expect(content).toContain("/data/hr/");
  });

  it("should return defaultAgentsMd unchanged for custom template", () => {
    const template = AGENT_TEMPLATES["custom"];
    const content = generateAgentsMd(template, undefined);
    expect(content).toBe(template.defaultAgentsMd);
  });

  it("should return defaultAgentsMd when no pluginConfig provided for knowledge-base", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, undefined);
    expect(content).toBe(template.defaultAgentsMd);
  });

  it("prepends a # name heading to Odoo template output", () => {
    // The display name used to be hard-coded as `# Sales Analyst` (etc.) at
    // the top of each Odoo template's raw defaultAgentsMd, duplicating
    // template.name. The name is now derived at render time so renaming a
    // template updates the heading automatically.
    const template = AGENT_TEMPLATES["odoo-sales-analyst"];
    const content = generateAgentsMd(template, undefined);
    expect(content).not.toBeNull();
    expect(content!.startsWith(`# ${template.name}\n`)).toBe(true);
  });

  it("no Odoo template hard-codes its display name as a top-level heading in raw defaultAgentsMd", () => {
    const offenders: string[] = [];
    for (const [id, template] of Object.entries(AGENT_TEMPLATES)) {
      if (!template.requiresOdooConnection) continue;
      if (!template.defaultAgentsMd) continue;
      if (template.defaultAgentsMd.startsWith(`# ${template.name}`)) {
        offenders.push(id);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every Odoo template's generated output contains exactly one top-level name heading", () => {
    for (const [id, template] of Object.entries(AGENT_TEMPLATES)) {
      if (!template.requiresOdooConnection) continue;
      const content = generateAgentsMd(template, undefined);
      expect(content, `Template ${id} generated null`).not.toBeNull();
      const escapedName = template.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = content!.match(new RegExp(`^# ${escapedName}$`, "gm")) ?? [];
      expect(
        matches.length,
        `Template ${id} has ${matches.length} top-level headings for "${template.name}" (expected 1)`
      ).toBe(1);
    }
  });
});

describe("Document templates", () => {
  const DOCUMENT_TEMPLATE_IDS = [
    "contract-analyzer",
    "resume-screener",
    "proposal-comparator",
    "compliance-checker",
    "onboarding-guide",
  ];

  it("all 5 document templates exist", () => {
    for (const id of DOCUMENT_TEMPLATE_IDS) {
      expect(getTemplate(id)).toBeDefined();
    }
  });

  it("all document templates use pinchy-files plugin", () => {
    for (const id of DOCUMENT_TEMPLATE_IDS) {
      const t = getTemplate(id)!;
      expect(t.pluginId).toBe("pinchy-files");
      expect(t.allowedTools).toEqual(["pinchy_ls", "pinchy_read"]);
    }
  });

  it("all document templates have non-null defaultAgentsMd", () => {
    for (const id of DOCUMENT_TEMPLATE_IDS) {
      const t = getTemplate(id)!;
      expect(t.defaultAgentsMd).toBeTruthy();
      expect(t.defaultAgentsMd!.length).toBeGreaterThan(100);
    }
  });

  it("all document templates have a defaultGreetingMessage", () => {
    for (const id of DOCUMENT_TEMPLATE_IDS) {
      const t = getTemplate(id)!;
      expect(t.defaultGreetingMessage).toBeTruthy();
    }
  });

  it("all document templates have a defaultTagline", () => {
    for (const id of DOCUMENT_TEMPLATE_IDS) {
      const t = getTemplate(id)!;
      expect(t.defaultTagline).toBeTruthy();
    }
  });

  it("contract-analyzer instructions mention contracts and clauses", () => {
    const t = getTemplate("contract-analyzer")!;
    expect(t.defaultAgentsMd).toMatch(/contract/i);
    expect(t.defaultAgentsMd).toMatch(/clause/i);
  });

  it("resume-screener instructions mention candidates and qualifications", () => {
    const t = getTemplate("resume-screener")!;
    expect(t.defaultAgentsMd).toMatch(/candidate|applicant|resume/i);
    expect(t.defaultAgentsMd).toMatch(/qualification|skill|experience/i);
  });

  it("proposal-comparator instructions mention proposals and comparison", () => {
    const t = getTemplate("proposal-comparator")!;
    expect(t.defaultAgentsMd).toMatch(/proposal|offer|bid/i);
    expect(t.defaultAgentsMd).toMatch(/compar/i);
  });

  it("compliance-checker instructions mention regulations and compliance", () => {
    const t = getTemplate("compliance-checker")!;
    expect(t.defaultAgentsMd).toMatch(/compliance|regulation|policy/i);
    expect(t.defaultAgentsMd).toMatch(/gap|violation|requirement/i);
  });

  it("onboarding-guide instructions mention onboarding and new employees", () => {
    const t = getTemplate("onboarding-guide")!;
    expect(t.defaultAgentsMd).toMatch(/onboarding|new (employee|team member|hire)/i);
    expect(t.defaultAgentsMd).toMatch(/process|procedure|guide/i);
  });

  it("document templates do not require odoo connection", () => {
    for (const id of DOCUMENT_TEMPLATE_IDS) {
      const t = getTemplate(id)!;
      expect(t.requiresOdooConnection).toBeFalsy();
    }
  });
});

describe("Odoo templates", () => {
  it("all 6 odoo templates exist", () => {
    const ids = [
      "odoo-sales-analyst",
      "odoo-inventory-scout",
      "odoo-finance-controller",
      "odoo-crm-assistant",
      "odoo-procurement-agent",
      "odoo-customer-service",
    ];
    for (const id of ids) {
      expect(getTemplate(id)).toBeDefined();
    }
  });

  it("odoo templates have requiresOdooConnection flag", () => {
    const t = getTemplate("odoo-sales-analyst");
    expect(t!.requiresOdooConnection).toBe(true);
  });

  it("odoo templates have odooConfig with accessLevel and requiredModels", () => {
    const t = getTemplate("odoo-sales-analyst");
    expect(t!.odooConfig).toBeDefined();
    expect(t!.odooConfig!.accessLevel).toBe("read-only");
    expect(t!.odooConfig!.requiredModels.length).toBeGreaterThan(0);
    expect(t!.odooConfig!.requiredModels[0]).toHaveProperty("model");
    expect(t!.odooConfig!.requiredModels[0]).toHaveProperty("operations");
  });

  it("read-only templates have only read tools", () => {
    const t = getTemplate("odoo-sales-analyst")!;
    expect(t.allowedTools).toContain("odoo_schema");
    expect(t.allowedTools).toContain("odoo_read");
    expect(t.allowedTools).not.toContain("odoo_create");
    expect(t.allowedTools).not.toContain("odoo_write");
  });

  it("read-write templates have read and write tools", () => {
    const t = getTemplate("odoo-crm-assistant")!;
    expect(t.allowedTools).toContain("odoo_read");
    expect(t.allowedTools).toContain("odoo_create");
    expect(t.allowedTools).toContain("odoo_write");
    expect(t.allowedTools).not.toContain("odoo_delete");
  });

  it("getTemplateList includes all odoo templates", () => {
    const list = getTemplateList();
    expect(list.length).toBeGreaterThanOrEqual(13); // 2 original + 5 document + 6 odoo
    expect(list.some((t) => t.id === "odoo-sales-analyst")).toBe(true);
    expect(list.some((t) => t.id === "odoo-customer-service")).toBe(true);
  });

  it("existing templates are not affected", () => {
    expect(getTemplate("knowledge-base")).toBeDefined();
    expect(getTemplate("custom")).toBeDefined();
    expect(getTemplate("knowledge-base")!.requiresOdooConnection).toBeFalsy();
  });

  it("all odoo templates have non-empty AGENTS.md instructions", () => {
    const ids = [
      "odoo-sales-analyst",
      "odoo-inventory-scout",
      "odoo-finance-controller",
      "odoo-crm-assistant",
      "odoo-procurement-agent",
      "odoo-customer-service",
    ];
    for (const id of ids) {
      const t = getTemplate(id)!;
      expect(t.defaultAgentsMd).toBeTruthy();
      expect(t.defaultAgentsMd!.length).toBeGreaterThan(200);
    }
  });

  it("sales analyst has sale.order and res.partner in requiredModels", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    const t = getTemplate("odoo-sales-analyst")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("sale.order");
    expect(models).toContain("res.partner");
  });

  it("sales analyst references docs for domain knowledge (margin analysis, field names)", () => {
    // Margin analysis and field-name specifics (list_price, standard_price) moved to
    // docs — the template delegates to docs_list/docs_read instead of hardcoding them.
    const t = getTemplate("odoo-sales-analyst")!;
    expect(t.defaultAgentsMd).toContain("docs_list");
    expect(t.defaultAgentsMd).toContain("docs_read");
    expect(t.defaultAgentsMd).toContain("odoo_schema");
  });

  it("sales analyst requires product.template for margin analysis", () => {
    const t = getTemplate("odoo-sales-analyst")!;
    const hasProductTemplate = t.odooConfig!.requiredModels.some(
      (m) => m.model === "product.template"
    );
    expect(hasProductTemplate).toBe(true);
  });

  it("inventory scout has stock.quant and stock.picking in requiredModels", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    const t = getTemplate("odoo-inventory-scout")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("stock.quant");
    expect(models).toContain("stock.picking");
  });

  it("finance controller has account.move and account.payment in requiredModels", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    const t = getTemplate("odoo-finance-controller")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("account.move");
    expect(models).toContain("account.payment");
  });

  it("CRM assistant has crm.lead in requiredModels and documents write capabilities", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    // Write capabilities are still documented in the ## Capabilities section.
    const t = getTemplate("odoo-crm-assistant")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("crm.lead");
    expect(t.defaultAgentsMd).toMatch(/create|CREATE/i);
  });

  it("procurement agent has purchase.order and product.supplierinfo in requiredModels", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    const t = getTemplate("odoo-procurement-agent")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("purchase.order");
    expect(models).toContain("product.supplierinfo");
  });

  it("customer service AGENTS.md mentions helpdesk.ticket", () => {
    const t = getTemplate("odoo-customer-service")!;
    expect(t.defaultAgentsMd).toContain("helpdesk.ticket");
    expect(t.defaultAgentsMd).toContain("sale.order");
  });

  it("customer service AGENTS.md explains that incoming emails arrive via Odoo mail alias", () => {
    const t = getTemplate("odoo-customer-service")!;
    // Make clear we rely on Odoo-native email routing, not external IMAP/Gmail
    expect(t.defaultAgentsMd).toMatch(/mail alias/i);
  });

  it("customer service AGENTS.md does not imply external email integrations", () => {
    const t = getTemplate("odoo-customer-service")!;
    // Should not suggest we read from Gmail, IMAP, Outlook, etc.
    expect(t.defaultAgentsMd).not.toMatch(/\b(gmail|imap|outlook|smtp inbox)\b/i);
  });

  it("customer service AGENTS.md documents the incoming-email workflow", () => {
    const t = getTemplate("odoo-customer-service")!;
    // Should document the flow: incoming mail → ticket/message → reply via Odoo
    expect(t.defaultAgentsMd).toMatch(/incoming/i);
  });

  it("all odoo AGENTS.md contain query instructions", () => {
    const ids = [
      "odoo-sales-analyst",
      "odoo-inventory-scout",
      "odoo-finance-controller",
      "odoo-crm-assistant",
      "odoo-procurement-agent",
      "odoo-customer-service",
    ];
    for (const id of ids) {
      const t = getTemplate(id)!;
      expect(t.defaultAgentsMd).toContain("odoo_schema");
      expect(t.defaultAgentsMd).toContain("odoo_read");
    }
  });
});

describe("suggestedNames", () => {
  it("all templates except custom have suggestedNames", () => {
    for (const [id, template] of Object.entries(AGENT_TEMPLATES)) {
      if (id === "custom") {
        expect(template.suggestedNames).toBeUndefined();
      } else {
        expect(template.suggestedNames).toBeDefined();
        expect(template.suggestedNames!.length).toBeGreaterThanOrEqual(5);
      }
    }
  });
});

describe("Additional Odoo templates (10 new)", () => {
  const NEW_ODOO_TEMPLATE_IDS = [
    "odoo-hr-analyst",
    "odoo-project-tracker",
    "odoo-manufacturing-planner",
    "odoo-recruitment-coordinator",
    "odoo-subscription-manager",
    "odoo-pos-analyst",
    "odoo-marketing-analyst",
    "odoo-expense-auditor",
    "odoo-fleet-manager",
    "odoo-website-analyst",
  ] as const;

  it("all 10 new odoo templates exist", () => {
    for (const id of NEW_ODOO_TEMPLATE_IDS) {
      expect(getTemplate(id), `missing template: ${id}`).toBeDefined();
    }
  });

  it("all new templates require an Odoo connection", () => {
    for (const id of NEW_ODOO_TEMPLATE_IDS) {
      const t = getTemplate(id)!;
      expect(t.requiresOdooConnection).toBe(true);
    }
  });

  it("all new templates have a valid odooConfig with required models", () => {
    for (const id of NEW_ODOO_TEMPLATE_IDS) {
      const t = getTemplate(id)!;
      expect(t.odooConfig).toBeDefined();
      expect(["read-only", "read-write"]).toContain(t.odooConfig!.accessLevel);
      expect(t.odooConfig!.requiredModels.length).toBeGreaterThan(0);
      for (const m of t.odooConfig!.requiredModels) {
        expect(m).toHaveProperty("model");
        expect(m).toHaveProperty("operations");
        expect(m.operations.length).toBeGreaterThan(0);
      }
    }
  });

  it("all new templates have non-trivial AGENTS.md instructions", () => {
    for (const id of NEW_ODOO_TEMPLATE_IDS) {
      const t = getTemplate(id)!;
      expect(t.defaultAgentsMd).toBeTruthy();
      expect(t.defaultAgentsMd!.length).toBeGreaterThan(200);
      expect(t.defaultAgentsMd).toContain("odoo_schema");
      expect(t.defaultAgentsMd).toContain("odoo_read");
    }
  });

  it("all new templates have a defaultTagline and greeting message", () => {
    for (const id of NEW_ODOO_TEMPLATE_IDS) {
      const t = getTemplate(id)!;
      expect(t.defaultTagline).toBeTruthy();
      expect(t.defaultGreetingMessage).toBeTruthy();
    }
  });

  it("all new templates have suggestedNames with at least 5 entries", () => {
    for (const id of NEW_ODOO_TEMPLATE_IDS) {
      const t = getTemplate(id)!;
      expect(t.suggestedNames).toBeDefined();
      expect(t.suggestedNames!.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("allowedTools respect the accessLevel", () => {
    for (const id of NEW_ODOO_TEMPLATE_IDS) {
      const t = getTemplate(id)!;
      expect(t.allowedTools).toContain("odoo_schema");
      expect(t.allowedTools).toContain("odoo_read");
      if (t.odooConfig!.accessLevel === "read-only") {
        expect(t.allowedTools).not.toContain("odoo_create");
        expect(t.allowedTools).not.toContain("odoo_write");
      }
      if (t.odooConfig!.accessLevel === "read-write") {
        expect(t.allowedTools).toContain("odoo_create");
        expect(t.allowedTools).toContain("odoo_write");
      }
      expect(t.allowedTools).not.toContain("odoo_delete");
    }
  });

  // Domain-specific assertions: each template must have its signature models in requiredModels
  it("HR Analyst has hr.employee and hr.leave in requiredModels", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    const t = getTemplate("odoo-hr-analyst")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("hr.employee");
    expect(models).toContain("hr.leave");
  });

  it("Project Tracker has project.project and project.task in requiredModels", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    const t = getTemplate("odoo-project-tracker")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("project.project");
    expect(models).toContain("project.task");
  });

  it("Manufacturing Planner has mrp.production and mrp.bom in requiredModels", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    const t = getTemplate("odoo-manufacturing-planner")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("mrp.production");
    expect(models).toContain("mrp.bom");
  });

  it("Recruitment Coordinator has hr.applicant and hr.job in requiredModels (read-write)", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    const t = getTemplate("odoo-recruitment-coordinator")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("hr.applicant");
    expect(models).toContain("hr.job");
    expect(t.odooConfig!.accessLevel).toBe("read-write");
  });

  it("Subscription Manager mentions sale.order with recurring/subscription context", () => {
    const t = getTemplate("odoo-subscription-manager")!;
    expect(t.defaultAgentsMd).toMatch(/sale\.order|sale\.subscription/);
    expect(t.defaultAgentsMd).toMatch(/recurring|subscription|MRR|churn/i);
  });

  it("Subscription Manager only references models that are in requiredModels (or guards them)", () => {
    // The legacy sale.subscription / sale.subscription.plan models are NOT in
    // requiredModels — modern Odoo (17+) uses sale.order with is_subscription
    // instead. The AGENTS.md must not tell the agent to confidently query
    // sale.subscription, otherwise it will get permission errors on every
    // query in modern Odoo. Any mention must be guarded with conditional
    // language ("if available", "may not exist", "check via odoo_schema first").
    const t = getTemplate("odoo-subscription-manager")!;
    const grantedModels = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(grantedModels).not.toContain("sale.subscription");
    expect(grantedModels).not.toContain("sale.subscription.plan");

    // If sale.subscription is mentioned at all, it must be guarded
    if (/sale\.subscription/.test(t.defaultAgentsMd)) {
      expect(t.defaultAgentsMd).toMatch(
        /may not exist|if available|if (the )?model exists|check.*odoo_schema|not granted|legacy.*may/i
      );
    }
  });

  it("POS Analyst has pos.order and pos.session in requiredModels", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    const t = getTemplate("odoo-pos-analyst")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("pos.order");
    expect(models).toContain("pos.session");
  });

  it("Marketing Analyst has mailing.mailing and mailing.trace in requiredModels", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    const t = getTemplate("odoo-marketing-analyst")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("mailing.mailing");
    expect(models).toContain("mailing.trace");
  });

  it("Expense Auditor has hr.expense in requiredModels and flags policy/suspicious language", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    // Policy/flag language is still present in the role description and rules.
    const t = getTemplate("odoo-expense-auditor")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("hr.expense");
    expect(t.defaultAgentsMd).toMatch(/policy|flag|violat|suspicious|unusual/i);
  });

  it("Expense Auditor frames list_price as an org convention, not a standard policy cap", () => {
    // list_price is Odoo's standard "reference price" for a product. Some
    // organizations repurpose it as an expense policy cap, but that is a
    // local convention, not a built-in Odoo concept. The AGENTS.md must
    // not present it as a fact, otherwise the agent will confidently flag
    // false positives in orgs that use list_price for its actual purpose.
    const t = getTemplate("odoo-expense-auditor")!;
    expect(t.defaultAgentsMd).not.toMatch(/reference price \/ policy cap/i);
    expect(t.defaultAgentsMd).toMatch(/some (orgs|organizations)|if your org|convention/i);
  });

  it("Fleet Manager has fleet.vehicle and service log models in requiredModels", () => {
    // Model names previously checked in defaultAgentsMd are now discovered via
    // odoo_schema at runtime. The source of truth is requiredModels (controls access).
    const t = getTemplate("odoo-fleet-manager")!;
    const models = t.odooConfig!.requiredModels.map((m) => m.model);
    expect(models).toContain("fleet.vehicle");
    expect(models.some((m) => m.startsWith("fleet.vehicle.log"))).toBe(true);
  });

  it("Website Analyst mentions website_id filter on sale.order", () => {
    const t = getTemplate("odoo-website-analyst")!;
    expect(t.defaultAgentsMd).toContain("sale.order");
    expect(t.defaultAgentsMd).toContain("website_id");
  });

  it("getTemplateList returns at least 23 templates (2 + 5 docs + 16 odoo)", () => {
    const list = getTemplateList();
    expect(list.length).toBeGreaterThanOrEqual(23);
    for (const id of NEW_ODOO_TEMPLATE_IDS) {
      expect(list.some((t) => t.id === id)).toBe(true);
    }
  });
});

describe("deriveOdooAccessLevel", () => {
  it("returns 'read-only' when every operation is read", () => {
    expect(deriveOdooAccessLevel([{ operations: ["read"] }, { operations: ["read"] }])).toBe(
      "read-only"
    );
  });

  it("returns 'read-write' when any model has create or write", () => {
    expect(
      deriveOdooAccessLevel([{ operations: ["read"] }, { operations: ["read", "write"] }])
    ).toBe("read-write");

    expect(deriveOdooAccessLevel([{ operations: ["read", "create"] }])).toBe("read-write");
  });

  it("returns 'full' when any model has delete", () => {
    expect(deriveOdooAccessLevel([{ operations: ["read", "write", "delete"] }])).toBe("full");
  });
});

describe("createOdooTemplate", () => {
  const baseSpec = {
    iconName: "TrendingUp" as const,
    name: "Test Analyst",
    description: "Analyze things",
    defaultPersonality: "the-pilot" as const,
    defaultTagline: "Analyze things",
    suggestedNames: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"],
    defaultGreetingMessage: "Hi. Let's analyze.",
    defaultAgentsMd: "## Your Role\nTest role.",
  };

  it("sets requiresOdooConnection to true", () => {
    const t = createOdooTemplate({
      ...baseSpec,
      requiredModels: [{ model: "sale.order", operations: ["read"] }],
    });
    expect(t.requiresOdooConnection).toBe(true);
  });

  it("sets pluginId to null", () => {
    const t = createOdooTemplate({
      ...baseSpec,
      requiredModels: [{ model: "sale.order", operations: ["read"] }],
    });
    expect(t.pluginId).toBeNull();
  });

  it("derives accessLevel from the highest operation across all required models", () => {
    const readOnly = createOdooTemplate({
      ...baseSpec,
      requiredModels: [{ model: "sale.order", operations: ["read"] }],
    });
    expect(readOnly.odooConfig?.accessLevel).toBe("read-only");

    const readWrite = createOdooTemplate({
      ...baseSpec,
      requiredModels: [
        { model: "sale.order", operations: ["read"] },
        { model: "crm.lead", operations: ["read", "write"] },
      ],
    });
    expect(readWrite.odooConfig?.accessLevel).toBe("read-write");
  });

  it("derives allowedTools from the computed access level", () => {
    const readOnly = createOdooTemplate({
      ...baseSpec,
      requiredModels: [{ model: "sale.order", operations: ["read"] }],
    });
    expect(readOnly.allowedTools).toEqual(getOdooToolsForAccessLevel("read-only"));

    const readWrite = createOdooTemplate({
      ...baseSpec,
      requiredModels: [{ model: "crm.lead", operations: ["read", "create", "write"] }],
    });
    expect(readWrite.allowedTools).toEqual(getOdooToolsForAccessLevel("read-write"));
  });

  it("exposes the requiredModels on odooConfig", () => {
    const requiredModels = [
      { model: "sale.order", operations: ["read"] as const },
      { model: "res.partner", operations: ["read"] as const },
    ];
    const t = createOdooTemplate({ ...baseSpec, requiredModels });
    expect(t.odooConfig?.requiredModels).toEqual(requiredModels);
  });

  it("preserves the caller-provided fields verbatim", () => {
    const t = createOdooTemplate({
      ...baseSpec,
      requiredModels: [{ model: "sale.order", operations: ["read"] }],
    });
    expect(t.iconName).toBe(baseSpec.iconName);
    expect(t.name).toBe(baseSpec.name);
    expect(t.description).toBe(baseSpec.description);
    expect(t.defaultPersonality).toBe(baseSpec.defaultPersonality);
    expect(t.defaultTagline).toBe(baseSpec.defaultTagline);
    expect(t.suggestedNames).toEqual(baseSpec.suggestedNames);
    expect(t.defaultGreetingMessage).toBe(baseSpec.defaultGreetingMessage);
    expect(t.defaultAgentsMd).toBe(baseSpec.defaultAgentsMd);
  });
});

describe("Odoo template drift invariants", () => {
  // These invariants catch a specific class of bug: the declared accessLevel
  // drifting away from what the actual requiredModels operations demand. Before
  // the createOdooTemplate factory existed, each template set accessLevel,
  // allowedTools, and requiredModels manually — which made it trivially easy
  // for a new "read-write" template to ship with only "read" ops on its
  // models (or vice versa), silently granting the agent tools it should not
  // have — or denying tools it needs.
  const odooEntries = Object.entries(AGENT_TEMPLATES).filter(([, t]) => t.requiresOdooConnection);

  it("every Odoo template's accessLevel is the minimal level its operations require", () => {
    const drifted: Array<{ id: string; declared: string; derived: string }> = [];
    for (const [id, t] of odooEntries) {
      const derived = deriveOdooAccessLevel(t.odooConfig!.requiredModels);
      if (t.odooConfig!.accessLevel !== derived) {
        drifted.push({ id, declared: t.odooConfig!.accessLevel, derived });
      }
    }
    expect(drifted).toEqual([]);
  });

  it("MUTATION CHECK: drift is actually detected when operations exceed accessLevel", () => {
    // Mutation guard: fabricate an inconsistent template shape and verify the
    // comparison above would have caught it. This proves the drift test isn't
    // vacuously green — if deriveOdooAccessLevel ever returned the wrong
    // level, the drift invariant above would silently pass with no signal.
    const fabricated = {
      odooConfig: {
        accessLevel: "read-only" as const,
        requiredModels: [{ model: "crm.lead", operations: ["read", "write"] as const }],
      },
    };
    const derived = deriveOdooAccessLevel(fabricated.odooConfig.requiredModels);
    expect(derived).toBe("read-write");
    expect(fabricated.odooConfig.accessLevel).not.toBe(derived);
  });

  it("every Odoo template's allowedTools matches getOdooToolsForAccessLevel(accessLevel)", () => {
    const drifted: Array<{ id: string }> = [];
    for (const [id, t] of odooEntries) {
      const expected = getOdooToolsForAccessLevel(t.odooConfig!.accessLevel);
      const actual = [...t.allowedTools].sort();
      const want = [...expected].sort();
      if (actual.length !== want.length || !actual.every((v, i) => v === want[i])) {
        drifted.push({ id });
      }
    }
    expect(drifted).toEqual([]);
  });
});

describe("docs_list/docs_read references", () => {
  it("all Odoo templates reference docs_list and docs_read in their defaultAgentsMd", () => {
    const odooTemplateKeys = Object.keys(AGENT_TEMPLATES).filter((key) => key.startsWith("odoo-"));
    expect(odooTemplateKeys.length).toBeGreaterThan(0);

    for (const key of odooTemplateKeys) {
      const template = AGENT_TEMPLATES[key];
      expect(template.defaultAgentsMd, `Template ${key} should mention docs_list`).toContain(
        "docs_list"
      );
      expect(template.defaultAgentsMd, `Template ${key} should mention docs_read`).toContain(
        "docs_read"
      );
    }
  });
});

describe("pickSuggestedName", () => {
  it("picks a name from the template's suggestedNames", () => {
    const name = pickSuggestedName("knowledge-base", []);
    const template = getTemplate("knowledge-base")!;
    expect(template.suggestedNames).toContain(name);
  });

  it("avoids names already in use", () => {
    const template = getTemplate("knowledge-base")!;
    const allButLast = template.suggestedNames!.slice(0, -1);
    const name = pickSuggestedName("knowledge-base", allButLast);
    expect(name).toBe(template.suggestedNames!.at(-1));
  });

  it("appends number when all names are taken", () => {
    const template = getTemplate("knowledge-base")!;
    const allNames = [...template.suggestedNames!];
    const name = pickSuggestedName("knowledge-base", allNames);
    // Should be one of the suggested names with a number suffix
    const baseName = name.replace(/ \d+$/, "");
    expect(template.suggestedNames).toContain(baseName);
  });

  it("increments number until unique", () => {
    const template = getTemplate("knowledge-base")!;
    const firstName = template.suggestedNames![0];
    const taken = [...template.suggestedNames!, `${firstName} 2`, `${firstName} 3`];
    const name = pickSuggestedName("knowledge-base", taken);
    expect(name).toBe(`${firstName} 4`);
  });

  it("returns empty string for unknown template", () => {
    expect(pickSuggestedName("nonexistent", [])).toBe("");
  });

  it("returns empty string for custom template", () => {
    expect(pickSuggestedName("custom", [])).toBe("");
  });
});
