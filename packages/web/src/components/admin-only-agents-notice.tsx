"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { apiPost, errorMessage } from "@/lib/api-client";
import type { AgentRef } from "@/lib/admin-only-agents";
import type { OpenAdminOnlyAgentsInput } from "@/lib/schemas/agents";

function agentCount(n: number) {
  return `${n} shared agent${n === 1 ? "" : "s"}`;
}

/** The route's per-request cap (`openAdminOnlyAgentsSchema`). */
const BATCH_SIZE = 200;
/** Names spelled out in the confirm dialog before "and N more". */
const NAMED_IN_DIALOG = 10;

function namesForDialog(agents: AgentRef[]) {
  const names = agents.slice(0, NAMED_IN_DIALOG).map((a) => a.name);
  const rest = agents.length - names.length;
  return rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
}

interface AdminOnlyAgentsNoticeProps {
  /** Shared agents stored as Restricted with no group (#1278). */
  agents: AgentRef[];
  /** With a license these agents are admin-only now; without one, they will be. */
  licenseActive: boolean;
  /** Called with the agents that were made visible to everyone. */
  onOpened: (opened: AgentRef[]) => void;
}

/**
 * Restricted with no group means "admins only" under a license — and every new
 * shared agent starts that way, which a community instance hides by showing
 * them to everyone. So entering the first key used to make every shared agent
 * vanish for members without a word. This names those agents before and after
 * activation, links each to the tab that fixes it once a license is active, and offers the one bulk
 * remedy that restores what members had — as an explicit, confirmed action,
 * never an automatic one.
 */
export function AdminOnlyAgentsNotice({
  agents,
  licenseActive,
  onOpened,
}: AdminOnlyAgentsNoticeProps) {
  const [confirming, setConfirming] = useState(false);
  const [opening, setOpening] = useState(false);

  if (agents.length === 0) return null;

  const handleOpen = async () => {
    setOpening(true);
    const opened: AgentRef[] = [];
    try {
      for (let i = 0; i < agents.length; i += BATCH_SIZE) {
        const result = await apiPost<{ agents: AgentRef[] }, OpenAdminOnlyAgentsInput>(
          "/api/agents/admin-only/open-to-all",
          { agentIds: agents.slice(i, i + BATCH_SIZE).map((a) => a.id) }
        );
        opened.push(...result.agents);
      }
      const n = opened.length;
      if (n === 0) {
        // Someone else got there first, or the agents got groups meanwhile.
        toast("Nothing to change — these agents were already updated. The list is refreshed.");
      } else {
        toast.success(`${n} agent${n === 1 ? " is" : "s are"} now visible to everyone.`);
      }
      setConfirming(false);
      onOpened(opened);
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't change who can see these agents"));
      // An earlier batch may already have gone through; keep the list honest.
      if (opened.length > 0) onOpened(opened);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border bg-muted/50 p-4">
      {licenseActive ? (
        <>
          <p className="text-sm font-medium">{agentCount(agents.length)} only admins can use</p>
          <p className="text-sm text-muted-foreground">
            {agents.length === 1
              ? "It's set to Restricted with no group, so members don't see it. Pick groups on its Access tab, or make it visible to everyone again."
              : "They're set to Restricted with no group, so members don't see them. Pick groups on each agent's Access tab, or make them visible to everyone again."}
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium">
            {agentCount(agents.length)} {agents.length === 1 ? "has" : "have"} no group yet
          </p>
          <p className="text-sm text-muted-foreground">
            {agents.length === 1
              ? "Everyone can use it today. Once a license is active, only admins can use it until you pick groups on its Access tab or make it visible to everyone."
              : "Everyone can use them today. Once a license is active, only admins can use them until you pick groups on each agent's Access tab or make them visible to everyone."}
          </p>
        </>
      )}
      <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
        {agents.map((agent) => (
          <li key={agent.id}>
            {/* Without a license the Access tab is an upgrade card, so a link
                there would lead nowhere useful yet. */}
            {licenseActive ? (
              <Link
                href={`/chat/${agent.id}/settings?tab=access`}
                className="text-primary-accent underline"
              >
                {agent.name}
              </Link>
            ) : (
              agent.name
            )}
          </li>
        ))}
      </ul>
      {licenseActive && (
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          Make visible to everyone
        </Button>
      )}

      <AlertDialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Make {agents.length} agent{agents.length === 1 ? "" : "s"} visible to everyone?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every user will be able to see and chat with {namesForDialog(agents)}. You can
              restrict them again on each agent&apos;s Access tab. This is recorded in the audit
              log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={opening}
              onClick={(e) => {
                // Keep the dialog open until the request settles, so a
                // failure is shown next to the action that caused it.
                e.preventDefault();
                void handleOpen();
              }}
            >
              {opening ? "Saving..." : "Make visible"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
