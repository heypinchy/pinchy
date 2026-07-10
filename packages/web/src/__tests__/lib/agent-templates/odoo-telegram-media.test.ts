import { describe, it, expect } from "vitest";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";
import { SMITHERS_SOUL_MD } from "@/lib/smithers-soul";

/**
 * Telegram media mirroring lands inbound media at `uploads/<name>` in the
 * agent's workspace, and `odoo_attach_file` accepts either the bare `<name>`
 * or the full `[media attached: /root/.openclaw/media/inbound/<name>]` hint.
 * Every template that grants `odoo_attach_file` (i.e. carries `ir.attachment`
 * create access) must teach the agent that mapping proactively, so it never
 * has to guess — a production agent once hallucinated plausible filenames and
 * asked the user to re-upload under those names. Templates without file/
 * attachment capability must NOT carry this guidance — it would be noise.
 */
describe("odoo templates: Telegram media -> uploads mapping", () => {
  const attachCapableIds = Object.entries(AGENT_TEMPLATES)
    .filter(([, template]) =>
      (template.odooConfig?.requiredModels ?? []).some(
        (m) => m.model === "ir.attachment" && m.operations.includes("create")
      )
    )
    .map(([id]) => id);

  it("finds the expected set of attach-capable Odoo templates", () => {
    // Pinned so a newly added attach-capable template is deliberately
    // reviewed for this guidance instead of silently slipping through.
    expect(attachCapableIds.sort()).toEqual(
      [
        "odoo-warehouse-operator",
        "odoo-bookkeeper",
        "odoo-hr-operator",
        "odoo-project-manager",
        "odoo-production-operator",
        "odoo-approval-manager",
      ].sort()
    );
  });

  it.each(attachCapableIds)("%s teaches the Telegram media -> uploads mapping", (id) => {
    const md = AGENT_TEMPLATES[id].defaultAgentsMd ?? "";
    expect(md).toMatch(/\[media attached: \/root\/\.openclaw\/media\/inbound\/<name>\]/);
    expect(md).toMatch(/uploads directory/i);
    expect(md).toMatch(/odoo_attach_file/);
    expect(md).toMatch(/never invent or guess filenames/i);
  });

  it("does not add the guidance to templates without attachment capability", () => {
    const nonAttachIds = Object.keys(AGENT_TEMPLATES).filter(
      (id) => !attachCapableIds.includes(id)
    );
    for (const id of nonAttachIds) {
      const md = AGENT_TEMPLATES[id].defaultAgentsMd ?? "";
      expect(md).not.toMatch(/\[media attached: \/root\/\.openclaw\/media\/inbound\/<name>\]/);
    }
  });

  it("does not touch the Smithers soul (no feature-specific updates there)", () => {
    // Smithers' soul is explicitly excluded from feature-specific updates
    // (repo convention) — guard against accidentally propagating this
    // Odoo/Telegram-specific guidance into it.
    expect(SMITHERS_SOUL_MD).not.toMatch(
      /\[media attached: \/root\/\.openclaw\/media\/inbound\/<name>\]/
    );
  });
});
