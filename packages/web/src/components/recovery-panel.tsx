"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { Button } from "@/components/ui/button";
import type { ModelCapability } from "@/lib/model-resolver/types";
import type { ModelCapabilities } from "@/lib/model-capabilities/cache";

type AgentRef = { id: string; name: string };
type ProviderModel = { id: string; name: string; capabilities: ModelCapabilities };
type ProviderGroup = { id: string; name: string; models: ProviderModel[] };

type RecoveryPanelProps = {
  filename: string;
  capability: ModelCapability;
  agentId: string;
  agentName: string;
  agentModel: string;
  canEditAgent: boolean;
  isAdmin: boolean;
  providers: ProviderGroup[];
  otherCompatibleAgents: AgentRef[];
  onUpdateAgent: (newModel: string) => Promise<void>;
  onRemoveAttachment: () => void;
  onDismiss: () => void;
};

export function RecoveryPanel({
  filename,
  capability,
  agentName,
  agentModel,
  canEditAgent,
  isAdmin,
  providers,
  otherCompatibleAgents,
  onUpdateAgent,
  onRemoveAttachment,
  onDismiss,
}: RecoveryPanelProps) {
  const [selectedModel, setSelectedModel] = useState("");
  const [updating, setUpdating] = useState(false);

  const capabilityLabel = capability === "vision" ? "image" : capability;

  async function handleUpdate() {
    if (!selectedModel) return;
    setUpdating(true);
    try {
      await onUpdateAgent(selectedModel);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div role="region" aria-label="Can't be sent">
      <div className="flex items-start justify-between">
        <h3>Attachment can&apos;t be sent</h3>
        <button aria-label="Dismiss" onClick={onDismiss}>
          <X />
        </button>
      </div>
      <p>
        <strong>{agentName}</strong>&apos;s current model (<code>{agentModel}</code>) doesn&apos;t
        accept {capabilityLabel} inputs (<strong>{filename}</strong>).
      </p>
      {canEditAgent && (
        <div>
          <ModelPicker
            value={selectedModel}
            onChange={setSelectedModel}
            providers={providers}
            requiredCapabilities={[capability]}
            filterToCompatible
          />
          <Button onClick={handleUpdate} disabled={!selectedModel || updating}>
            Update agent
          </Button>
        </div>
      )}
      {!canEditAgent && otherCompatibleAgents.length > 0 && (
        <div>
          <p>Use a different agent:</p>
          <ul>
            {otherCompatibleAgents.map((a) => (
              <li key={a.id}>
                <a href={`/chat/${a.id}`}>{a.name}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button variant="outline" onClick={onRemoveAttachment}>
        Remove attachment
      </Button>
      {isAdmin &&
        providers.every((p) =>
          p.models.every((m) => !m.capabilities[capability as keyof typeof m.capabilities])
        ) && <a href="/settings/providers">Add a vision-capable provider in Settings</a>}
    </div>
  );
}
