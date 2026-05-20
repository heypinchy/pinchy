"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DiagnosticsExportDialog } from "@/components/diagnostics-export-dialog";

export interface SettingsSupportProps {
  agents: Array<{ id: string; name: string }>;
}

const HELPER_TEXT =
  "Generates a JSON file with your recent conversation, model and tool activity, " +
  "and version info. Secrets and emails are automatically removed. You decide if " +
  "and how to share it with Pinchy support.";

export function SettingsSupport({ agents }: SettingsSupportProps) {
  const [selectedId, setSelectedId] = useState<string>(agents[0]?.id ?? "");
  const [dialogOpen, setDialogOpen] = useState(false);

  if (agents.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-medium">Support</h2>
        <p className="text-sm text-muted-foreground">
          You don&apos;t have access to any agents yet. Once an agent is shared with you, you can
          generate a diagnostics export from here.
        </p>
      </div>
    );
  }

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? agents[0];

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-medium">Support</h2>
        <p className="text-sm text-muted-foreground">
          Generate a diagnostics export to share with Pinchy support when you run into an issue with
          an agent.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="support-agent-select">Agent</Label>
        {agents.length === 1 ? (
          <p id="support-agent-select" className="text-sm">
            Agent: <span className="font-medium">{selectedAgent.name}</span>
          </p>
        ) : (
          <Select value={selectedAgent.id} onValueChange={setSelectedId}>
            <SelectTrigger id="support-agent-select" className="w-full max-w-sm">
              <SelectValue placeholder="Select an agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="space-y-2">
        <Button type="button" onClick={() => setDialogOpen(true)}>
          Generate diagnostics export
        </Button>
        <p className="text-xs text-muted-foreground max-w-prose">{HELPER_TEXT}</p>
      </div>

      <DiagnosticsExportDialog
        open={dialogOpen}
        agentId={selectedAgent.id}
        agentName={selectedAgent.name}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}
