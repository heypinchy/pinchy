"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { TOOL_REGISTRY } from "@/lib/tool-registry";
import { defaultConfirmTools } from "@/lib/approvals/policy";

interface ApprovalConfirmationSectionProps {
  /** The agent's currently-allowed tool ids. */
  allowedTools: string[];
  /** Tool ids that require confirmation. */
  confirmTools: string[];
  onChange: (next: string[]) => void;
}

/**
 * Admin control for #124 Tier 2: pick which of the agent's tools pause and ask
 * the acting user to confirm before running. "Use recommended" pre-selects the
 * powerful (write/side-effecting) tools so the common case is one click.
 */
export function ApprovalConfirmationSection({
  allowedTools,
  confirmTools,
  onChange,
}: ApprovalConfirmationSectionProps) {
  const tools = allowedTools
    .map((id) => TOOL_REGISTRY.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t) && !t!.deprecated);

  if (tools.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Add tools in the sections above, then choose which ones require confirmation.
      </p>
    );
  }

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(confirmTools);
    if (checked) next.add(id);
    else next.delete(id);
    onChange([...next]);
  };

  const recommended = defaultConfirmTools(allowedTools);

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
          onClick={() => onChange(recommended)}
          disabled={recommended.length === 0}
        >
          Use recommended
        </Button>
      </div>
      <div className="space-y-2">
        {tools.map((tool) => (
          <div key={tool.id} className="flex items-center gap-2">
            <Checkbox
              id={`confirm-${tool.id}`}
              checked={confirmTools.includes(tool.id)}
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
