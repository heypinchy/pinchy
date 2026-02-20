"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DeleteAgentDialog } from "@/components/delete-agent-dialog";

interface AgentSettingsGeneralProps {
  agent: { id: string; name: string; model: string };
  providers: Array<{
    id: string;
    name: string;
    models: Array<{ id: string; name: string }>;
  }>;
  onSaved?: () => void;
  canDelete?: boolean;
}

export function AgentSettingsGeneral({
  agent,
  providers,
  onSaved,
  canDelete,
}: AgentSettingsGeneralProps) {
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(agent.model);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const providersWithModels = providers.filter((p) => p.models.length > 0);

  async function handleSave() {
    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, model }),
      });

      if (!res.ok) {
        const data = await res.json();
        setFeedback({ type: "error", message: data.error || "Failed to save" });
        return;
      }

      setFeedback({ type: "success", message: "Saved." });
      onSaved?.();
    } catch {
      setFeedback({ type: "error", message: "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="agent-name">Name</Label>
        <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="agent-model">Model</Label>
        <select
          id="agent-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {providersWithModels.map((provider) => (
            <optgroup key={provider.id} label={provider.name}>
              {provider.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="space-y-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>

        <p className="text-sm text-muted-foreground">
          Saving will briefly disconnect all active chats while the agent runtime restarts.
        </p>
      </div>

      {feedback && (
        <p
          className={
            feedback.type === "success" ? "text-sm text-green-600" : "text-sm text-red-600"
          }
        >
          {feedback.message}
        </p>
      )}

      {canDelete && (
        <div className="pt-6 border-t">
          <h3 className="text-sm font-medium text-destructive mb-2">Danger Zone</h3>
          <DeleteAgentDialog agentId={agent.id} agentName={agent.name} />
        </div>
      )}
    </div>
  );
}
