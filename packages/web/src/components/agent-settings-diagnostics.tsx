"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DiagnosticsExportDialog } from "@/components/diagnostics-export-dialog";

interface AgentSettingsDiagnosticsProps {
  agentId: string;
  agentName: string;
}

/**
 * Agent Settings → Diagnostics tab.
 *
 * The export is per-agent, and here the agent is already in context, so there's
 * no agent picker — unlike the old general Settings → Support flow this replaces.
 * Chat selection (#639) is handled entirely inside DiagnosticsExportDialog: we
 * don't pass a `chatId`, so it preselects the agent's default chat.
 */
export function AgentSettingsDiagnostics({ agentId, agentName }: AgentSettingsDiagnosticsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-lg font-medium">Diagnostics</h3>
        <p className="text-sm text-muted-foreground">
          Run into an issue with {agentName}? Generate a diagnostics export to share with Pinchy
          support.
        </p>
      </div>

      <Button type="button" onClick={() => setDialogOpen(true)}>
        Generate diagnostics export
      </Button>

      <DiagnosticsExportDialog
        open={dialogOpen}
        agentId={agentId}
        agentName={agentName}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}
