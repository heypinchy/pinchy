"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { apiGet, apiPatch, apiDelete, ApiError } from "@/lib/api-client";
import type { AutomationListItem } from "@/lib/schemas/automations";
import type { EmailWorkflowFilter } from "@/lib/email-workflows/types";
import type { EmailWorkflowStatus } from "@/db/enums";
import { AgentSettingsAutomationCreateDialog } from "@/components/agent-settings-automation-create-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

/**
 * Turn a deterministic workflow filter into human-readable clauses. The stored
 * shape is machine data (design §5); a reviewer needs to see *what mail this
 * triggers on* in plain words before switching it on. An all-empty filter
 * watches everything, so we say so explicitly rather than render nothing.
 */
function summarizeFilter(filter: EmailWorkflowFilter): string[] {
  const parts: string[] = [];
  if (filter.from?.length) parts.push(`From ${filter.from.join(", ")}`);
  if (filter.toDomain?.length) parts.push(`To domain ${filter.toDomain.join(", ")}`);
  if (filter.subjectContains?.length)
    parts.push(`Subject contains ${filter.subjectContains.join(", ")}`);
  if (filter.hasAttachment) parts.push("Has an attachment");
  if (filter.attachmentType) parts.push(`Attachment is ${filter.attachmentType}`);
  if (filter.folder) parts.push(`In folder ${filter.folder}`);
  return parts;
}

// Status is a health signal the dispatcher writes (pending → active/error), not
// something this tab owns. We only render it so a reviewer can tell a proposal
// (pending) from a running workflow (active) from one that hit trouble (error).
const STATUS_VARIANT: Record<EmailWorkflowStatus, "default" | "secondary" | "destructive"> = {
  active: "default",
  pending: "secondary",
  error: "destructive",
};

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

/**
 * The Automations tab: the review-and-activate surface for an agent's Inbox
 * Agent email workflows (#139). Workflows are created disabled (write API #864)
 * and the sweep dispatches only enabled ones, so this is where a human vets the
 * structured translation and flips it on — the human-gated step "propose, don't
 * self-activate" reserves for a person. Editing a workflow's fields, and the
 * conversational way to create one, live elsewhere (#705); this tab lists,
 * enables/disables, and deletes.
 *
 * Self-contained (like the Telegram/Diagnostics tabs): it does its own GET and
 * persists each toggle/delete immediately, outside the page's shared draft/Save
 * flow. The management API enforces the same scope gate that hides this tab from
 * users who cannot manage the agent.
 */
export function AgentSettingsAutomations({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<AutomationListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AutomationListItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // No synchronous setState here: `loading` starts true and the `finally`
  // clears it, so the effect that calls this never sets state before its first
  // await (react-hooks/set-state-in-effect). The tab mounts once, so there is no
  // re-fetch that would need to re-show the skeleton.
  const load = useCallback(async () => {
    try {
      const data = await apiGet<AutomationListItem[]>(
        `/api/automations?agentId=${encodeURIComponent(agentId)}`
      );
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(errorMessage(e, "Failed to load automations"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    // Deferred past the effect body so the initial setState happens in a
    // microtask, not synchronously inside the effect (react-hooks/
    // set-state-in-effect) — same pattern as connected-apps.tsx.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function handleToggle(item: AutomationListItem) {
    const next = !item.enabled;
    // Optimistic: flip immediately, roll back if the PATCH is rejected. We never
    // touch `status` — the dispatcher flips pending → active on the next sweep.
    setItems((prev) => prev.map((w) => (w.id === item.id ? { ...w, enabled: next } : w)));
    setBusyId(item.id);
    try {
      await apiPatch(`/api/automations/${item.id}`, { enabled: next });
    } catch (e) {
      setItems((prev) => prev.map((w) => (w.id === item.id ? { ...w, enabled: item.enabled } : w)));
      toast.error(errorMessage(e, "Failed to update automation"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(item: AutomationListItem) {
    setBusyId(item.id);
    try {
      await apiDelete(`/api/automations/${item.id}`);
      setItems((prev) => prev.filter((w) => w.id !== item.id));
      toast.success("Automation deleted");
    } catch (e) {
      toast.error(errorMessage(e, "Failed to delete automation"));
    } finally {
      setBusyId(null);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Automations</h2>
          <p className="text-sm text-muted-foreground">
            Email workflows this agent can run on its own. Review each proposal and switch it on
            when you&apos;re ready — nothing runs until you enable it.
          </p>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => setCreateOpen(true)}>
          New automation
        </Button>
      </div>

      <AgentSettingsAutomationCreateDialog
        agentId={agentId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={load}
      />

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No automations yet. When this agent proposes an email workflow, it shows up here for you
          to review and enable.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Mailboxes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Manage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const clauses = summarizeFilter(item.filter);
                const mailboxCount = item.connectionIds.length;
                return (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell>
                      {clauses.length === 0 ? (
                        <span className="text-muted-foreground">Entire mailbox</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {clauses.map((clause) => (
                            <Badge key={clause} variant="outline" className="font-normal">
                              {clause}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs truncate" title={item.action}>
                      {item.action}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {mailboxCount} {mailboxCount === 1 ? "mailbox" : "mailboxes"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[item.status]}>{item.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant={item.enabled ? "outline" : "default"}
                        disabled={busyId === item.id}
                        onClick={() => handleToggle(item)}
                      >
                        {item.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-2 text-destructive hover:text-destructive"
                        disabled={busyId === item.id}
                        onClick={() => setDeleteTarget(item)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this automation?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `"${deleteTarget.name}" will be removed for good. This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog controlled: run the delete, close on our terms.
                e.preventDefault();
                if (deleteTarget) handleDelete(deleteTarget);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
