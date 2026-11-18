"use client";

import { DiagnosticsExportForm } from "@/components/diagnostics-export-form";

interface AgentSettingsDiagnosticsProps {
  agentId: string;
  agentName: string;
}

/**
 * Agent Settings → Diagnostics tab.
 *
 * The form is inline: this tab is already the dedicated surface for the one
 * task it offers, so a modal would only add a click, a focus trap, and a
 * duplicate of the heading — while squeezing the chat picker into a width it
 * doesn't fit. The per-message "Report issue to support" flow in chat still
 * uses DiagnosticsExportDialog, where a modal earns its keep.
 *
 * The export is per-agent, and here the agent is already in context, so there's
 * no agent picker — unlike the old general Settings → Support flow this
 * replaces. Chat selection (#639) lives in the form: we don't pass a `chatId`,
 * so it preselects the agent's default chat.
 */
export function AgentSettingsDiagnostics({ agentId, agentName }: AgentSettingsDiagnosticsProps) {
  return (
    <div className="max-w-xl space-y-6">
      <div className="space-y-2">
        <h3 className="text-lg font-medium">Diagnostics</h3>
        <p className="text-sm text-muted-foreground">
          Run into an issue with {agentName}? Generate a file containing your recent conversation,
          model and tool activity, and version info. Secrets and emails are automatically removed.
          You decide if and how to share it with Pinchy support.
        </p>
      </div>

      <DiagnosticsExportForm
        agentId={agentId}
        agentName={agentName}
        submitLabel="Generate diagnostics export"
      />
    </div>
  );
}
