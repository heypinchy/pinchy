import { describe, it, expect } from "vitest";
import { ODOO_TEMPLATES } from "@/lib/agent-templates/data/odoo-agents";
import { KNOWN_SKILLS, getSkillBody, isKnownSkill } from "@/lib/skills";

/**
 * Contract for the Odoo template → skill migration (#546). The workflow
 * invariants that used to be spliced into every Odoo template's
 * defaultAgentsMd now live in shared SKILL.md bodies, referenced through
 * `defaultSkills`. These guards keep the template → skill mapping honest and
 * self-extending as templates change.
 */
describe("odoo template ↔ skill contract", () => {
  const entries = Object.entries(ODOO_TEMPLATES);

  const modelsWith = (t: (typeof ODOO_TEMPLATES)[string], op: string) =>
    (t.odooConfig?.requiredModels ?? []).filter((m) => m.operations.includes(op as never));

  const isWriteCapable = (t: (typeof ODOO_TEMPLATES)[string]) =>
    t.odooConfig?.accessLevel !== "read-only";

  const isAttachCapable = (t: (typeof ODOO_TEMPLATES)[string]) =>
    (t.odooConfig?.requiredModels ?? []).some(
      (m) => m.model === "ir.attachment" && m.operations.includes("create")
    );

  it("every Odoo template declares at least one skill", () => {
    for (const [id, t] of entries) {
      expect((t.defaultSkills ?? []).length, `${id} has no defaultSkills`).toBeGreaterThan(0);
    }
  });

  it("every declared skill is a KNOWN_SKILLS entry (drift guard)", () => {
    for (const [id, t] of entries) {
      for (const skill of t.defaultSkills ?? []) {
        expect(isKnownSkill(skill), `${id} references unknown skill "${skill}"`).toBe(true);
      }
    }
  });

  it("declared skills are unique per template (no duplicates)", () => {
    for (const [id, t] of entries) {
      const skills = t.defaultSkills ?? [];
      expect(new Set(skills).size, `${id} has duplicate skills`).toBe(skills.length);
    }
  });

  it("every Odoo template carries odoo-read (the universal read foundation)", () => {
    for (const [id, t] of entries) {
      expect(t.defaultSkills ?? [], `${id} missing odoo-read`).toContain("odoo-read");
    }
  });

  it("write-capable templates carry odoo-write; read-only ones do not", () => {
    for (const [id, t] of entries) {
      const carries = (t.defaultSkills ?? []).includes("odoo-write");
      expect(carries, `${id} write-capable=${isWriteCapable(t)} but odoo-write=${carries}`).toBe(
        isWriteCapable(t)
      );
    }
  });

  it("attach-capable templates (ir.attachment create) carry odoo-attach; others do not", () => {
    for (const [id, t] of entries) {
      const carries = (t.defaultSkills ?? []).includes("odoo-attach");
      expect(carries, `${id} attach-capable=${isAttachCapable(t)} but odoo-attach=${carries}`).toBe(
        isAttachCapable(t)
      );
    }
  });

  it("templates that manage mail.activity (create/write) carry odoo-activities", () => {
    for (const [id, t] of entries) {
      const managesActivities = modelsWith(t, "create").some((m) => m.model === "mail.activity");
      const carries = (t.defaultSkills ?? []).includes("odoo-activities");
      if (managesActivities) {
        expect(carries, `${id} manages mail.activity but is missing odoo-activities`).toBe(true);
      }
    }
  });

  it("only bookkeeper carries odoo-gross-to-net, and only warehouse/production carry odoo-lot-serial", () => {
    const grossToNet = entries.filter(([, t]) =>
      (t.defaultSkills ?? []).includes("odoo-gross-to-net")
    );
    expect(grossToNet.map(([id]) => id).sort()).toEqual(["odoo-bookkeeper"]);

    const lotSerial = entries.filter(([, t]) =>
      (t.defaultSkills ?? []).includes("odoo-lot-serial")
    );
    expect(lotSerial.map(([id]) => id).sort()).toEqual([
      "odoo-production-operator",
      "odoo-warehouse-operator",
    ]);
  });

  it("each odoo-* skill body carries its defining content", () => {
    const anchors: Record<string, RegExp> = {
      "odoo-read": /odoo_describe_model/,
      "odoo-write": /duplicate|verify/i,
      "odoo-attach": /_pinchy_ref/,
      "odoo-activities": /odoo_schedule_activity/,
      "odoo-multi-company": /company_id/,
      "odoo-gross-to-net": /tax-exclusive/i,
      "odoo-lot-serial": /lot.*serial|tracking/i,
    };
    for (const [skill, anchor] of Object.entries(anchors)) {
      expect(KNOWN_SKILLS as readonly string[], `${skill} not in KNOWN_SKILLS`).toContain(skill);
      expect(getSkillBody(skill as (typeof KNOWN_SKILLS)[number]), `${skill} body`).toMatch(anchor);
    }
  });
});
