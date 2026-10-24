"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { TOOL_REGISTRY } from "@/lib/tool-registry";
import { defaultConfirmMap, type ConfirmMap } from "@/lib/approvals/policy";

interface ApprovalConfirmationSectionProps {
  /** The agent's currently-allowed tool ids. */
  allowedTools: string[];
  /** The agent's confirmation policy, keyed by tool (and optionally resource). */
  confirm: ConfirmMap;
  onChange: (next: ConfirmMap) => void;
}

/**
 * Admin control for #124 Tier 2: pick which of the agent's tools pause and ask
 * the acting user to confirm before running. "Use recommended" pre-selects the
 * powerful (write/side-effecting) tools so the common case is one click.
 *
 * This is the TOOL level. Per-model exceptions for Odoo ("ask before deleting
 * an invoice, just do it for a note", #1133) are set in the Odoo permission
 * matrix, where the model rows already are — a second model grid here would
 * duplicate that table and let the two disagree. What is set here is what an
 * untouched model cell inherits.
 */
export function ApprovalConfirmationSection({
  allowedTools,
  confirm,
  onChange,
}: ApprovalConfirmationSectionProps) {
  // Every tool the agent may call is offerable here, whether or not it is in
  // TOOL_REGISTRY. The registry is the catalogue of *grantable* tools; an agent
  // can hold tools from outside it — Smithers, the agent every install has,
  // carries only the onboarding context tools, which personal-agent.ts grants
  // directly. Filtering through the registry rendered an empty section on the
  // default agent. The gate matches on tool NAME and never reads the registry,
  // so anything the agent can call must be gateable. Unknown tools fall back to
  // their id as the label and carry no category.
  const tools = allowedTools
    .map((id) => {
      const known = TOOL_REGISTRY.find((t) => t.id === id);
      return known ?? { id, label: id, category: undefined, deprecated: false };
    })
    .filter((t) => !t.deprecated);

  if (tools.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Add tools in the sections above, then choose which ones require confirmation.
      </p>
    );
  }

  const toggle = (id: string, checked: boolean) => {
    const next = { ...confirm };
    if (checked) next[id] = "confirm";
    // Deleting rather than writing "allow": an unset tool key is the absence of
    // a policy, which is what an admin means by unticking. Writing "allow"
    // would look identical here and behave identically at the gate, but it
    // would also be an explicit decision that a later "Use recommended" has to
    // reason about.
    else delete next[id];
    onChange(next);
  };

  // The recommended set replaces the tool-level entries and leaves per-model
  // exceptions alone: those are decisions someone made about a specific record
  // type, and a one-click default has no business discarding them.
  const recommended = defaultConfirmMap(allowedTools);
  const applyRecommended = () => {
    const exceptions = Object.fromEntries(
      Object.entries(confirm).filter(([key]) => key.includes(":"))
    );
    onChange({ ...recommended, ...exceptions });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          These tools pause and ask the acting user to confirm before the agent runs them.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={applyRecommended}
          disabled={Object.keys(recommended).length === 0}
        >
          Use recommended
        </Button>
      </div>
      <div className="space-y-2">
        {tools.map((tool) => (
          <div key={tool.id} className="flex items-center gap-2">
            <Checkbox
              id={`confirm-${tool.id}`}
              checked={confirm[tool.id] === "confirm"}
              onCheckedChange={(checked) => toggle(tool.id, checked === true)}
            />
            <Label htmlFor={`confirm-${tool.id}`} className="font-normal">
              {tool.label}
              {tool.category === "powerful" ? (
                <span className="ml-2 text-xs text-muted-foreground">(powerful)</span>
              ) : null}
            </Label>
          </div>
        ))}
      </div>
    </div>
  );
}
