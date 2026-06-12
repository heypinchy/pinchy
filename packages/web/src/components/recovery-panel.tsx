"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { Button } from "@/components/ui/button";
import type { ModelCapability } from "@/lib/model-resolver/types";
import type { ModelCapabilities } from "@/lib/model-capabilities/types";
import { capabilityField } from "@/lib/model-capabilities/capability-field";

type AgentRef = { id: string; name: string };
type ProviderModel = { id: string; name: string; capabilities?: ModelCapabilities };
type ProviderGroup = { id: string; name: string; models: ProviderModel[] };

type RecoveryPanelProps = {
  filename: string;
  capability: ModelCapability;
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

  const noProviderSupportsCapability =
    providers.length === 0 ||
    providers.every((p) =>
      p.models.every((m) => !m.capabilities || !capabilityField(m.capabilities, capability))
    );

  return (
    <div
      role="region"
      aria-label="Can't be sent"
      className="mb-3 rounded-md border border-amber-500/40 bg-amber-50 p-4 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <h3 className="text-sm font-semibold">Attachment can&apos;t be sent</h3>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="text-amber-800/70 hover:text-amber-900 dark:text-amber-200/70 dark:hover:text-amber-100"
        >
          <X className="size-4" />
        </button>
      </div>

      <p className="mt-2 ml-6 text-sm">
        <strong>{agentName}</strong>&apos;s current model (
        <code className="rounded bg-amber-100/60 px-1 py-0.5 text-xs dark:bg-amber-900/40">
          {agentModel}
        </code>
        ) doesn&apos;t accept {capabilityLabel} inputs (<strong>{filename}</strong>).
      </p>

      {canEditAgent && (
        <div className="mt-3 ml-6 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex-1">
            <ModelPicker
              value={selectedModel}
              onChange={setSelectedModel}
              providers={providers}
              requiredCapabilities={[capability]}
              filterToCompatible
            />
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleUpdate}
            disabled={!selectedModel || updating}
          >
            {updating ? "Updating…" : "Update agent"}
          </Button>
        </div>
      )}

      {!canEditAgent && otherCompatibleAgents.length > 0 && (
        <div className="mt-3 ml-6 text-sm">
          <p className="mb-1 font-medium">Use a different agent:</p>
          <ul className="flex flex-col gap-1">
            {otherCompatibleAgents.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/chat/${a.id}`}
                  className="underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300"
                >
                  {a.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 ml-6 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onRemoveAttachment}>
          Remove attachment
        </Button>
        {isAdmin && noProviderSupportsCapability && (
          <Link
            href="/settings?tab=provider"
            className="text-sm underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300"
          >
            Add a vision-capable provider in Settings
          </Link>
        )}
      </div>
    </div>
  );
}
