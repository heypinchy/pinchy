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

  it("custom is positioned after document templates and before odoo templates", () => {
    // The template selector grid renders templates in iteration order, so
    // changing where "custom" appears in AGENT_TEMPLATES is a UX-visible
    // change. Pin the position to catch accidental drift from the original
    // single-file ordering.
    const ids = Object.keys(AGENT_TEMPLATES);
    const customIndex = ids.indexOf("custom");
    const onboardingIndex = ids.indexOf("onboarding-guide");
    const firstOdooIndex = ids.findIndex((id) => id.startsWith("odoo-"));
    expect(customIndex).toBeGreaterThan(onboardingIndex);
    expect(customIndex).toBeLessThan(firstOdooIndex);
  });

  it("every non-custom template has a valid modelHint with tier", () => {
    for (const [id, tpl] of Object.entries(AGENT_TEMPLATES)) {
      if (id === "custom") continue; // deliberately no hint — user-built agent
      expect(tpl.modelHint, `template "${id}" missing modelHint`).toBeDefined();
      expect(tpl.modelHint?.tier, `template "${id}" has invalid tier`).toMatch(
        /^(fast|balanced|reasoning)$/
      );
    }
  });

  describe("email templates", () => {
    const emailTemplateIds = [
      "email-assistant",
      "email-sales-assistant",
      "email-support-assistant",
    ];

    it("all three email templates exist", () => {
      for (const id of emailTemplateIds) {
        expect(AGENT_TEMPLATES[id], `template "${id}" should exist`).toBeDefined();
      }
    });

    it("all email templates use pinchy-email pluginId", () => {
      for (const id of emailTemplateIds) {
        expect(AGENT_TEMPLATES[id].pluginId, `${id} pluginId`).toBe("pinchy-email");
      }
    });

    it("all email templates include email_list, email_read, email_search, email_draft tools", () => {
      const required = ["email_list", "email_read", "email_search", "email_draft"];
      for (const id of emailTemplateIds) {
        for (const tool of required) {
          expect(AGENT_TEMPLATES[id].allowedTools, `${id} should include ${tool}`).toContain(tool);
        }
      }
    });

    it("no email template includes email_send (safety: drafts only)", () => {
      for (const id of emailTemplateIds) {
        expect(AGENT_TEMPLATES[id].allowedTools).not.toContain("email_send");
      }
    });

    it("all email templates require an email connection", () => {
      for (const id of emailTemplateIds) {
        expect(
          (AGENT_TEMPLATES[id] as { requiresEmailConnection?: boolean }).requiresEmailConnection,
          `${id} requiresEmailConnection`
        ).toBe(true);
      }
    });

    it("email-assistant uses the-butler personality", () => {
      expect(AGENT_TEMPLATES["email-assistant"].defaultPersonality).toBe("the-butler");
    });

    it("email-sales-assistant uses the-pilot personality", () => {
      expect(AGENT_TEMPLATES["email-sales-assistant"].defaultPersonality).toBe("the-pilot");
    });

    it("email-support-assistant uses the-coach personality", () => {
      expect(AGENT_TEMPLATES["email-support-assistant"].defaultPersonality).toBe("the-coach");
    });

    it("all email templates have a non-Bot iconName", () => {
      for (const id of emailTemplateIds) {
        expect(AGENT_TEMPLATES[id].iconName, `${id} iconName`).toBeDefined();
        expect(AGENT_TEMPLATES[id].iconName, `${id} should not use Bot fallback`).not.toBe("Bot");
      }
    });

    it("all email templates have a defaultGreetingMessage", () => {
      for (const id of emailTemplateIds) {
        expect(
          AGENT_TEMPLATES[id].defaultGreetingMessage,
          `${id} defaultGreetingMessage`
        ).toBeTruthy();
      }
    });

    it("all email templates have balanced model hint with tools capability", () => {
      for (const id of emailTemplateIds) {
        expect(AGENT_TEMPLATES[id].modelHint).toMatchObject({
          tier: "balanced",
          capabilities: expect.arrayContaining(["tools"]),
        });
      }
    });
  });
});

describe("generateAgentsMd", () => {
  it("should include allowed paths for knowledge-base template", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, {
      "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
    });
    expect(content).toContain("/data/hr-docs/");
  });

  it("should instruct the agent to use pinchy_ls before reading files", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, {
      "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
    });
    expect(content).toContain("pinchy_ls");
  });

  it("should preserve the base knowledge base instructions", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, {
      "pinchy-files": { allowed_paths: ["/data/hr-docs/"] },
    });
    expect(content).toContain("knowledge base agent");
    expect(content).toContain("cite");
  });

  it("should include all provided paths when multiple paths given", () => {
    const template = AGENT_TEMPLATES["knowledge-base"];
    const content = generateAgentsMd(template, {
      "pinchy-files": { allowed_paths: ["/data/docs/", "/data/hr/"] },
    });
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

  it("sales analyst AGENTS.md mentions sale.order model", () => {
    const t = getTemplate("odoo-sales-analyst")!;
    expect(t.defaultAgentsMd).toContain("sale.order");
    expect(t.defaultAgentsMd).toContain("res.partner");
  });

  it("sales analyst AGENTS.md instructs on product margin calculation", () => {
    const t = getTemplate("odoo-sales-analyst")!;
    // Margin = list_price (sale) − standard_price (cost) per product
    expect(t.defaultAgentsMd).toContain("standard_price");
    expect(t.defaultAgentsMd).toContain("list_price");
    expect(t.defaultAgentsMd).toMatch(/margin/i);
  });

  it("sales analyst requires product.template for margin analysis", () => {
    const t = getTemplate("odoo-sales-analyst")!;
    const hasProductTemplate = t.odooConfig!.requiredModels.some(
      (m) => m.model === "product.template"
    );
    expect(hasProductTemplate).toBe(true);
  });

  it("inventory scout AGENTS.md mentions stock models", () => {
    const t = getTemplate("odoo-inventory-scout")!;
    expect(t.defaultAgentsMd).toContain("stock.quant");
    expect(t.defaultAgentsMd).toContain("stock.picking");
  });

  it("finance controller AGENTS.md mentions account models", () => {
    const t = getTemplate("odoo-finance-controller")!;
    expect(t.defaultAgentsMd).toContain("account.move");
    expect(t.defaultAgentsMd).toContain("account.payment");
  });

  it("CRM assistant AGENTS.md mentions crm.lead and write capabilities", () => {
    const t = getTemplate("odoo-crm-assistant")!;
    expect(t.defaultAgentsMd).toContain("crm.lead");
    expect(t.defaultAgentsMd).toMatch(/create|CREATE/i);
  });

  it("procurement agent AGENTS.md mentions purchase.order", () => {
    const t = getTemplate("odoo-procurement-agent")!;
    expect(t.defaultAgentsMd).toContain("purchase.order");
    expect(t.defaultAgentsMd).toContain("product.supplierinfo");
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

  // Domain-specific assertions: each template must mention its signature models
  it("HR Analyst mentions hr.employee and hr.leave", () => {
    const t = getTemplate("odoo-hr-analyst")!;
    expect(t.defaultAgentsMd).toContain("hr.employee");
    expect(t.defaultAgentsMd).toContain("hr.leave");
  });

  it("Project Tracker mentions project.project and project.task", () => {
    const t = getTemplate("odoo-project-tracker")!;
    expect(t.defaultAgentsMd).toContain("project.project");
    expect(t.defaultAgentsMd).toContain("project.task");
  });

  it("Manufacturing Planner mentions mrp.production and mrp.bom", () => {
    const t = getTemplate("odoo-manufacturing-planner")!;
    expect(t.defaultAgentsMd).toContain("mrp.production");
    expect(t.defaultAgentsMd).toContain("mrp.bom");
  });

  it("Recruitment Coordinator mentions hr.applicant and hr.job (read-write)", () => {
    const t = getTemplate("odoo-recruitment-coordinator")!;
    expect(t.defaultAgentsMd).toContain("hr.applicant");
    expect(t.defaultAgentsMd).toContain("hr.job");
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

  it("POS Analyst mentions pos.order and pos.session", () => {
    const t = getTemplate("odoo-pos-analyst")!;
    expect(t.defaultAgentsMd).toContain("pos.order");
    expect(t.defaultAgentsMd).toContain("pos.session");
  });

  it("Marketing Analyst mentions mailing.mailing and mailing.trace", () => {
    const t = getTemplate("odoo-marketing-analyst")!;
    expect(t.defaultAgentsMd).toContain("mailing.mailing");
    expect(t.defaultAgentsMd).toContain("mailing.trace");
  });

  it("Expense Auditor mentions hr.expense and policy/flag language", () => {
    const t = getTemplate("odoo-expense-auditor")!;
    expect(t.defaultAgentsMd).toContain("hr.expense");
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

  it("Fleet Manager mentions fleet.vehicle and service log models", () => {
    const t = getTemplate("odoo-fleet-manager")!;
    expect(t.defaultAgentsMd).toContain("fleet.vehicle");
    expect(t.defaultAgentsMd).toMatch(/fleet\.vehicle\.log/);
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

describe("Odoo Bookkeeper template (write counterpart of Finance Controller)", () => {
  it("exists with id odoo-bookkeeper", () => {
    expect(getTemplate("odoo-bookkeeper")).toBeDefined();
  });

  it("requires an Odoo connection", () => {
    expect(getTemplate("odoo-bookkeeper")!.requiresOdooConnection).toBe(true);
  });

  it("has read-write access level", () => {
    expect(getTemplate("odoo-bookkeeper")!.odooConfig!.accessLevel).toBe("read-write");
  });

  it("grants read+create+write on account.move and res.partner", () => {
    const t = getTemplate("odoo-bookkeeper")!;
    const byModel = new Map(t.odooConfig!.requiredModels.map((m) => [m.model, m.operations]));
    for (const model of ["account.move", "res.partner"]) {
      const ops = byModel.get(model);
      expect(ops, `missing ${model}`).toBeDefined();
      expect(ops).toContain("read");
      expect(ops).toContain("create");
      expect(ops).toContain("write");
    }
  });

  it("grants read+write but NOT create on account.move.line (lines flow via invoice_line_ids inline)", () => {
    // The Bookkeeper's mandatory workflow rule #3 forbids creating
    // account.move.line records separately — they must be inlined via the
    // account.move create's `invoice_line_ids` field. Granting `create` here
    // would be a permission the agent is documented never to use, and would
    // open a non-atomic invoice creation path. `write` stays so the agent can
    // edit lines on existing drafts (description, qty, tax) before posting.
    const t = getTemplate("odoo-bookkeeper")!;
    const line = t.odooConfig!.requiredModels.find((m) => m.model === "account.move.line");
    expect(line).toBeDefined();
    expect(line!.operations).toContain("read");
    expect(line!.operations).toContain("write");
    expect(line!.operations).not.toContain("create");
  });

  it("grants read+write but NOT create on account.payment", () => {
    // Payments originate from bank imports, not from the bookkeeper agent.
    // Reconciliation updates an existing payment's state — that's a write,
    // never a create.
    const t = getTemplate("odoo-bookkeeper")!;
    const payment = t.odooConfig!.requiredModels.find((m) => m.model === "account.payment");
    expect(payment).toBeDefined();
    expect(payment!.operations).toContain("read");
    expect(payment!.operations).toContain("write");
    expect(payment!.operations).not.toContain("create");
  });

  it("never grants delete on any model", () => {
    // Posted accounting records must never be deleted — only cancelled
    // (state → cancel), which is a write. Delete would silently break the
    // audit trail.
    const t = getTemplate("odoo-bookkeeper")!;
    for (const m of t.odooConfig!.requiredModels) {
      expect(m.operations, `${m.model} grants delete`).not.toContain("delete");
    }
  });

  it("declares vision in modelHint capabilities (paper receipts are the core workflow)", () => {
    const t = getTemplate("odoo-bookkeeper")!;
    expect(t.modelHint).toBeDefined();
    expect(t.modelHint!.capabilities).toContain("vision");
    expect(t.modelHint!.capabilities).toContain("tools");
  });

  it("AGENTS.md mandates draft-first workflow with explicit user confirmation before posting", () => {
    // Defense against mid-stream provider failures: draft records stay
    // reversible if the agent crashes between tool calls. Posting requires
    // explicit user confirmation as a vier-augen step.
    const t = getTemplate("odoo-bookkeeper")!;
    expect(t.defaultAgentsMd).toMatch(/draft/i);
    expect(t.defaultAgentsMd).toMatch(/confirm|confirmation/i);
  });

  it("AGENTS.md mandates duplicate-check before creating partners or invoices", () => {
    // Prevents double-booking when a provider 5xx kills the flow mid-create
    // and the user retries without realising records were already written.
    const t = getTemplate("odoo-bookkeeper")!;
    expect(t.defaultAgentsMd).toMatch(/duplicate|already exists|dedup/i);
  });

  it("AGENTS.md documents the one-shot invoice_line_ids create pattern", () => {
    // One create call per invoice: lines go inline via invoice_line_ids on
    // the account.move create. Separate create calls for account.move.line
    // leave half-finished invoices if the agent crashes between them.
    const t = getTemplate("odoo-bookkeeper")!;
    expect(t.defaultAgentsMd).toContain("invoice_line_ids");
  });

  it("appears in getTemplateList", () => {
    expect(getTemplateList().some((t) => t.id === "odoo-bookkeeper")).toBe(true);
  });
});

describe("Vision capability for read-write Odoo operator templates", () => {
  // Pinchy auto-defaults must pick a multimodal model for any agent that can
  // write records — invoices, delivery notes, CVs, screenshots are the
  // primary "paper into Odoo" workflow. Without vision in the hint, the
  // default resolver picks a text-only model and the user has to manually
  // override, sometimes landing on unstable Vision+Tools models.
  //
  // The list of operator templates is derived from the registry rather than
  // hard-coded — if a new Odoo template ships with accessLevel "read-write"
  // or "full" but forgets the vision capability hint, this invariant catches
  // it automatically.
  it("every read-write Odoo template requests vision capability", () => {
    const operators = Object.entries(AGENT_TEMPLATES).filter(
      ([, t]) =>
        t.requiresOdooConnection &&
        (t.odooConfig?.accessLevel === "read-write" || t.odooConfig?.accessLevel === "full")
    );

    // Smoke guard: if the filter ever returns nothing, the invariant would
    // pass vacuously and mask a regression where every operator lost the hint
    // (or the registry filtering broke).
    expect(operators.length).toBeGreaterThan(0);

    const missingVision: string[] = [];
    for (const [id, t] of operators) {
      if (!t.modelHint?.capabilities?.includes("vision")) {
        missingVision.push(id);
      }
    }
    expect(missingVision).toEqual([]);
  });
});

describe("Odoo Project Manager template (write counterpart of Project Tracker)", () => {
  it("exists with id odoo-project-manager", () => {
    expect(getTemplate("odoo-project-manager")).toBeDefined();
  });

  it("requires an Odoo connection", () => {
    expect(getTemplate("odoo-project-manager")!.requiresOdooConnection).toBe(true);
  });

  it("has read-write access level", () => {
    expect(getTemplate("odoo-project-manager")!.odooConfig!.accessLevel).toBe("read-write");
  });

  it("grants read+create+write on project.project and project.task", () => {
    const t = getTemplate("odoo-project-manager")!;
    const byModel = new Map(t.odooConfig!.requiredModels.map((m) => [m.model, m.operations]));
    for (const model of ["project.project", "project.task"]) {
      const ops = byModel.get(model);
      expect(ops, `missing ${model}`).toBeDefined();
      expect(ops).toContain("read");
      expect(ops).toContain("create");
      expect(ops).toContain("write");
    }
  });

  it("never grants delete on any model", () => {
    // Project/task deletion would break time tracking and audit trails.
    // Archive (active=false) is a write — that is the correct lever.
    const t = getTemplate("odoo-project-manager")!;
    for (const m of t.odooConfig!.requiredModels) {
      expect(m.operations, `${m.model} grants delete`).not.toContain("delete");
    }
  });

  it("AGENTS.md mandates confirmation before bulk operations", () => {
    // Reassigning twenty tasks or closing a whole stage is irreversible at
    // scale — the agent must talk the user through it first.
    const t = getTemplate("odoo-project-manager")!;
    expect(t.defaultAgentsMd).toMatch(/bulk|batch|mass/i);
    expect(t.defaultAgentsMd).toMatch(/confirm|confirmation/i);
  });

  it("AGENTS.md mandates duplicate-check before creating projects or tasks", () => {
    const t = getTemplate("odoo-project-manager")!;
    expect(t.defaultAgentsMd).toMatch(/duplicate|already exists|dedup/i);
  });

  it("AGENTS.md mentions project.project and project.task with write capabilities", () => {
    const t = getTemplate("odoo-project-manager")!;
    expect(t.defaultAgentsMd).toContain("project.project");
    expect(t.defaultAgentsMd).toContain("project.task");
    expect(t.defaultAgentsMd).toMatch(/create|update|assign/i);
  });

  it("appears in getTemplateList", () => {
    expect(getTemplateList().some((t) => t.id === "odoo-project-manager")).toBe(true);
  });
});

describe("Odoo HR Operator template (write counterpart of HR Analyst)", () => {
  it("exists with id odoo-hr-operator", () => {
    expect(getTemplate("odoo-hr-operator")).toBeDefined();
  });

  it("requires an Odoo connection", () => {
    expect(getTemplate("odoo-hr-operator")!.requiresOdooConnection).toBe(true);
  });

  it("has read-write access level", () => {
    expect(getTemplate("odoo-hr-operator")!.odooConfig!.accessLevel).toBe("read-write");
  });

  it("grants read+create+write on hr.leave and hr.attendance", () => {
    // These are the day-to-day write surfaces: leave requests and attendance entries.
    const t = getTemplate("odoo-hr-operator")!;
    const byModel = new Map(t.odooConfig!.requiredModels.map((m) => [m.model, m.operations]));
    for (const model of ["hr.leave", "hr.attendance"]) {
      const ops = byModel.get(model);
      expect(ops, `missing ${model}`).toBeDefined();
      expect(ops).toContain("read");
      expect(ops).toContain("create");
      expect(ops).toContain("write");
    }
  });

  it("grants read but NOT create on hr.contract (contracts are HR-admin territory)", () => {
    // Contracts touch salary, benefits, legal terms. Operator can read for context
    // (e.g. to know an employee's working time), but never create or amend.
    const t = getTemplate("odoo-hr-operator")!;
    const contract = t.odooConfig!.requiredModels.find((m) => m.model === "hr.contract");
    expect(contract).toBeDefined();
    expect(contract!.operations).toContain("read");
    expect(contract!.operations).not.toContain("create");
    expect(contract!.operations).not.toContain("write");
  });

  it("grants read but NOT create on hr.employee (new hires are HR-admin territory)", () => {
    // Creating an employee record is a HR-admin action — it triggers payroll,
    // legal contracts, system access. Operator can update existing employees
    // (e.g. work email) but never onboard new ones.
    const t = getTemplate("odoo-hr-operator")!;
    const emp = t.odooConfig!.requiredModels.find((m) => m.model === "hr.employee");
    expect(emp).toBeDefined();
    expect(emp!.operations).toContain("read");
    expect(emp!.operations).not.toContain("create");
  });

  it("never grants delete on any model", () => {
    const t = getTemplate("odoo-hr-operator")!;
    for (const m of t.odooConfig!.requiredModels) {
      expect(m.operations, `${m.model} grants delete`).not.toContain("delete");
    }
  });

  it("AGENTS.md mandates confidentiality and double-check before write", () => {
    // HR data is highly sensitive — wrong leave / wrong attendance / wrong
    // employee disrupts payroll. The agent must confirm before any write.
    const t = getTemplate("odoo-hr-operator")!;
    expect(t.defaultAgentsMd).toMatch(/confidential|sensitive|private/i);
    expect(t.defaultAgentsMd).toMatch(/confirm|confirmation/i);
  });

  it("AGENTS.md flags contract-related questions as out-of-scope for write", () => {
    // The agent must redirect the user to HR-admin for salary/contract changes.
    const t = getTemplate("odoo-hr-operator")!;
    expect(t.defaultAgentsMd).toMatch(/hr.contract/);
    expect(t.defaultAgentsMd).toMatch(/HR admin|payroll|out of scope|cannot|won.t/i);
  });

  it("appears in getTemplateList", () => {
    expect(getTemplateList().some((t) => t.id === "odoo-hr-operator")).toBe(true);
  });
});

describe("Odoo Warehouse Operator template (write counterpart of Inventory Scout)", () => {
  it("exists with id odoo-warehouse-operator", () => {
    expect(getTemplate("odoo-warehouse-operator")).toBeDefined();
  });

  it("requires an Odoo connection", () => {
    expect(getTemplate("odoo-warehouse-operator")!.requiresOdooConnection).toBe(true);
  });

  it("has read-write access level", () => {
    expect(getTemplate("odoo-warehouse-operator")!.odooConfig!.accessLevel).toBe("read-write");
  });

  it("grants read+create+write on stock.picking, stock.move, stock.move.line", () => {
    // These are the records used to record receipts, internal transfers, deliveries.
    const t = getTemplate("odoo-warehouse-operator")!;
    const byModel = new Map(t.odooConfig!.requiredModels.map((m) => [m.model, m.operations]));
    for (const model of ["stock.picking", "stock.move", "stock.move.line"]) {
      const ops = byModel.get(model);
      expect(ops, `missing ${model}`).toBeDefined();
      expect(ops).toContain("read");
      expect(ops).toContain("create");
      expect(ops).toContain("write");
    }
  });

  it("grants read+write on stock.quant (no create — quants are auto-managed by Odoo)", () => {
    // Quants are managed by Odoo itself based on move flows. Manually creating
    // a quant outside of an inventory adjustment leaves a non-auditable hole.
    const t = getTemplate("odoo-warehouse-operator")!;
    const quant = t.odooConfig!.requiredModels.find((m) => m.model === "stock.quant");
    expect(quant).toBeDefined();
    expect(quant!.operations).toContain("read");
    expect(quant!.operations).toContain("write");
    expect(quant!.operations).not.toContain("create");
  });

  it("never grants delete on any model", () => {
    const t = getTemplate("odoo-warehouse-operator")!;
    for (const m of t.odooConfig!.requiredModels) {
      expect(m.operations, `${m.model} grants delete`).not.toContain("delete");
    }
  });

  it("AGENTS.md emphasises picking-confirmation workflow and validate semantics", () => {
    // The agent should explain that validating a picking turns "planned" into
    // "done" and updates stock — irreversible at scale.
    const t = getTemplate("odoo-warehouse-operator")!;
    expect(t.defaultAgentsMd).toMatch(/validate|button_validate|button_done/i);
    expect(t.defaultAgentsMd).toMatch(/confirm|confirmation/i);
  });

  it("AGENTS.md mentions inventory adjustments and warns against unscoped writes", () => {
    const t = getTemplate("odoo-warehouse-operator")!;
    expect(t.defaultAgentsMd).toMatch(/inventory adjustment|stock\.quant/);
    expect(t.defaultAgentsMd).toMatch(/duplicate|dedup|already|existing/i);
  });

  it("appears in getTemplateList", () => {
    expect(getTemplateList().some((t) => t.id === "odoo-warehouse-operator")).toBe(true);
  });
});

describe("Odoo Production Operator template (write counterpart of Manufacturing Planner)", () => {
  it("exists with id odoo-production-operator", () => {
    expect(getTemplate("odoo-production-operator")).toBeDefined();
  });

  it("requires an Odoo connection", () => {
    expect(getTemplate("odoo-production-operator")!.requiresOdooConnection).toBe(true);
  });

  it("has read-write access level", () => {
    expect(getTemplate("odoo-production-operator")!.odooConfig!.accessLevel).toBe("read-write");
  });

  it("grants read+create+write on mrp.production and read+write on mrp.workorder", () => {
    // Production orders can be created (new MOs); workorders are created by
    // Odoo from the BOM/routing, so the operator only updates progress.
    const t = getTemplate("odoo-production-operator")!;
    const byModel = new Map(t.odooConfig!.requiredModels.map((m) => [m.model, m.operations]));

    const production = byModel.get("mrp.production");
    expect(production).toBeDefined();
    expect(production).toContain("read");
    expect(production).toContain("create");
    expect(production).toContain("write");

    const workorder = byModel.get("mrp.workorder");
    expect(workorder).toBeDefined();
    expect(workorder).toContain("read");
    expect(workorder).toContain("write");
  });

  it("grants read-only on mrp.bom (BOMs are engineering territory)", () => {
    // BOM changes flow from R&D / engineering, not the shop floor.
    const t = getTemplate("odoo-production-operator")!;
    const bom = t.odooConfig!.requiredModels.find((m) => m.model === "mrp.bom");
    expect(bom).toBeDefined();
    expect(bom!.operations).toContain("read");
    expect(bom!.operations).not.toContain("create");
    expect(bom!.operations).not.toContain("write");
  });

  it("never grants delete on any model", () => {
    const t = getTemplate("odoo-production-operator")!;
    for (const m of t.odooConfig!.requiredModels) {
      expect(m.operations, `${m.model} grants delete`).not.toContain("delete");
    }
  });

  it("AGENTS.md covers MO lifecycle (confirm, start, finish) and warns on irreversible steps", () => {
    const t = getTemplate("odoo-production-operator")!;
    expect(t.defaultAgentsMd).toMatch(/mrp\.production/);
    expect(t.defaultAgentsMd).toMatch(/confirm|in_progress|done|button_mark_done/i);
    expect(t.defaultAgentsMd).toMatch(/irreversible|cannot.*undo|consume|backflush/i);
  });

  it("AGENTS.md tells the agent to flag BOM mismatches rather than edit BOMs", () => {
    // BOM is read-only — agent must route discrepancies to engineering.
    const t = getTemplate("odoo-production-operator")!;
    expect(t.defaultAgentsMd).toMatch(/engineering|R&D|out of scope/i);
  });

  it("appears in getTemplateList", () => {
    expect(getTemplateList().some((t) => t.id === "odoo-production-operator")).toBe(true);
  });
});

describe("Odoo Approval Manager template (cross-module approvals)", () => {
  it("exists with id odoo-approval-manager", () => {
    expect(getTemplate("odoo-approval-manager")).toBeDefined();
  });

  it("requires an Odoo connection", () => {
    expect(getTemplate("odoo-approval-manager")!.requiresOdooConnection).toBe(true);
  });

  it("has read-write access level", () => {
    expect(getTemplate("odoo-approval-manager")!.odooConfig!.accessLevel).toBe("read-write");
  });

  it("grants read+write on the four approval-bearing models", () => {
    // Approvals are state-transitions on existing records — write, never create.
    // The four core surfaces are: expenses (sheets), leaves, purchase orders, and
    // the generic approval.request model when present.
    const t = getTemplate("odoo-approval-manager")!;
    const byModel = new Map(t.odooConfig!.requiredModels.map((m) => [m.model, m.operations]));
    for (const model of ["hr.expense.sheet", "hr.leave", "purchase.order"]) {
      const ops = byModel.get(model);
      expect(ops, `missing ${model}`).toBeDefined();
      expect(ops).toContain("read");
      expect(ops).toContain("write");
    }
  });

  it("marks Enterprise-only approval models as optional (so Community connections can still create the agent)", () => {
    // `approval.request` and `approval.category` ship with Odoo Enterprise's
    // Approvals module. On Community they do not exist, and without the
    // optional flag the missing-models gate in new-agent-form.tsx disables
    // the Create button entirely. Marking them optional keeps Community
    // users able to create an Approval Manager that still covers expenses /
    // leaves / POs.
    const t = getTemplate("odoo-approval-manager")!;
    const byModel = new Map(t.odooConfig!.requiredModels.map((m) => [m.model, m]));
    expect(byModel.get("approval.request")?.optional).toBe(true);
    expect(byModel.get("approval.category")?.optional).toBe(true);
  });

  it("does NOT grant create on approval surfaces (approvals act on existing records)", () => {
    // The agent approves what already exists; it does not file expense reports,
    // request leave, or create POs. Those originate from other roles.
    const t = getTemplate("odoo-approval-manager")!;
    const byModel = new Map(t.odooConfig!.requiredModels.map((m) => [m.model, m.operations]));
    for (const model of ["hr.expense.sheet", "hr.leave", "purchase.order"]) {
      const ops = byModel.get(model)!;
      expect(ops, `${model} should not grant create`).not.toContain("create");
    }
  });

  it("never grants delete on any model", () => {
    const t = getTemplate("odoo-approval-manager")!;
    for (const m of t.odooConfig!.requiredModels) {
      expect(m.operations, `${m.model} grants delete`).not.toContain("delete");
    }
  });

  it("AGENTS.md prescribes a four-step approval ritual (read → policy-check → confirm → write)", () => {
    const t = getTemplate("odoo-approval-manager")!;
    expect(t.defaultAgentsMd).toMatch(/policy|policies|threshold|limit/i);
    expect(t.defaultAgentsMd).toMatch(/confirm|confirmation/i);
    expect(t.defaultAgentsMd).toMatch(/reject|refuse/i);
  });

  it("AGENTS.md warns about authority limits and forwarding above-threshold requests", () => {
    const t = getTemplate("odoo-approval-manager")!;
    expect(t.defaultAgentsMd).toMatch(/authority|threshold|escalat|above|exceeds/i);
  });

  it("AGENTS.md does not use the ambiguous 'approve your own policy' phrasing", () => {
    // Earlier draft said "Never approve your own policy — that is, never
    // invent authority", which models tend to parse as "never approve
    // requests you yourself submitted". The intent is the opposite:
    // never *invent* authority. Test guards against regressing to the
    // ambiguous wording.
    const t = getTemplate("odoo-approval-manager")!;
    expect(t.defaultAgentsMd).not.toMatch(/approve\s+\*?\*?your\s+own\*?\*?\s+policy/i);
    expect(t.defaultAgentsMd).toMatch(/invent authority|invent policy|never create policy/i);
  });

  it("appears in getTemplateList", () => {
    expect(getTemplateList().some((t) => t.id === "odoo-approval-manager")).toBe(true);
  });
});
