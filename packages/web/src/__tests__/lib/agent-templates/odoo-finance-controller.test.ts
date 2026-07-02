import { describe, it, expect } from "vitest";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";

describe("odoo-finance-controller template", () => {
  const template = AGENT_TEMPLATES["odoo-finance-controller"];
  const md = template.defaultAgentsMd;
  const required = template.odooConfig?.requiredModels ?? [];
  const modelOps = (m: string) => required.find((r) => r.model === m)?.operations ?? [];

  it("stays read-only", () => {
    expect(template.odooConfig?.accessLevel).toBe("read-only");
  });

  it("grants read access to the subscription view (sale.order + line + plan)", () => {
    expect(modelOps("sale.order")).toContain("read");
    expect(modelOps("sale.order.line")).toContain("read");
    expect(modelOps("sale.subscription.plan")).toContain("read");
  });

  it("documents the modern is_subscription model, not the nonexistent legacy sale.subscription", () => {
    expect(md).toMatch(/sale\.order/);
    expect(md).toMatch(/is_subscription/);
    // The record model `sale.subscription` does not exist in Odoo 17+ — never steer the agent there.
    expect(md).not.toMatch(/`sale\.subscription`/);
  });

  it("guards the optional sale.subscription.plan mention with conditional language", () => {
    // sale.subscription.plan is granted `optional: true` — it does not exist on
    // instances without the Subscriptions module, so mentioning it without a
    // caveat steers the agent into permission/model errors there (same
    // convention as the Subscription Manager legacy-model guard).
    expect(md).toMatch(/sale\.subscription\.plan/);
    expect(md).toMatch(/may not exist/i);
  });
});
