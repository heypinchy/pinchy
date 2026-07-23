"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import type { AutomationConnectionOption, CreateAutomationInput } from "@/lib/schemas/automations";
import type { EmailWorkflowFilter } from "@/lib/email-workflows/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

/** Default sweep window (days) — mirrors the schema default so the form and the
 * server agree on what "leave it blank" means. */
const DEFAULT_SWEEP_WINDOW_DAYS = 14;

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

/** Split a comma-separated input into trimmed, non-empty tokens. */
function parseList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The create dialog for an Inbox Agent email workflow (#139) — the first UI path
 * to author one. It resolves the same object POST /api/automations writes, so it
 * shares the {@link CreateAutomationInput} contract with the route and the future
 * conversational tool (#705).
 *
 * The mailbox picker is populated from GET /api/automations/connections, which
 * resolves choices through the same email-read permission gate the create route
 * enforces — so the form can only offer mailboxes the server will accept.
 *
 * Propose, don't self-activate: the route always writes the workflow
 * pending + disabled, so there is no "enable now" control here — activation is
 * the reviewer's separate step in the tab.
 */
export function AgentSettingsAutomationCreateDialog({
  agentId,
  open,
  onOpenChange,
  onCreated,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [connections, setConnections] = useState<AutomationConnectionOption[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [toDomain, setToDomain] = useState("");
  const [subjectContains, setSubjectContains] = useState("");
  const [hasAttachment, setHasAttachment] = useState(false);
  const [attachmentType, setAttachmentType] = useState("");
  const [folder, setFolder] = useState("");
  const [sweepWindowDays, setSweepWindowDays] = useState(String(DEFAULT_SWEEP_WINDOW_DAYS));
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<string[]>([]);

  // Fresh form on each open (React-recommended "adjust state during render"
  // instead of an effect). Also clears the picker and re-arms the loading state
  // so a reopen re-fetches rather than showing a stale mailbox list.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setName("");
      setAction("");
      setFrom("");
      setToDomain("");
      setSubjectContains("");
      setHasAttachment(false);
      setAttachmentType("");
      setFolder("");
      setSweepWindowDays(String(DEFAULT_SWEEP_WINDOW_DAYS));
      setSelectedConnectionIds([]);
      setConnections([]);
      setLoadingConnections(true);
    }
  }

  const load = useCallback(async () => {
    setLoadingConnections(true);
    try {
      const data = await apiGet<AutomationConnectionOption[]>(
        `/api/automations/connections?agentId=${encodeURIComponent(agentId)}`
      );
      setConnections(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(errorMessage(e, "Failed to load mailboxes"));
      setConnections([]);
    } finally {
      setLoadingConnections(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (!open) return;
    // Deferred past the effect body so the setState in `load` runs in a
    // microtask, not synchronously inside the effect (react-hooks/
    // set-state-in-effect) — same pattern as connected-apps.tsx.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [open, load]);

  function toggleConnection(id: string, checked: boolean) {
    setSelectedConnectionIds((prev) => (checked ? [...prev, id] : prev.filter((c) => c !== id)));
  }

  function buildFilter(): EmailWorkflowFilter {
    const filter: EmailWorkflowFilter = {};
    const fromList = parseList(from);
    if (fromList.length) filter.from = fromList;
    const toDomainList = parseList(toDomain);
    if (toDomainList.length) filter.toDomain = toDomainList;
    const subjectList = parseList(subjectContains);
    if (subjectList.length) filter.subjectContains = subjectList;
    if (hasAttachment) filter.hasAttachment = true;
    if (attachmentType.trim()) filter.attachmentType = attachmentType.trim();
    if (folder.trim()) filter.folder = folder.trim();
    return filter;
  }

  const canSubmit =
    name.trim().length > 0 &&
    action.trim().length > 0 &&
    selectedConnectionIds.length > 0 &&
    !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const parsedDays = Number.parseInt(sweepWindowDays, 10);
    const payload: CreateAutomationInput = {
      agentId,
      name: name.trim(),
      action: action.trim(),
      filter: buildFilter(),
      connectionIds: selectedConnectionIds,
      sweepWindowDays:
        Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : DEFAULT_SWEEP_WINDOW_DAYS,
    };
    setSubmitting(true);
    try {
      await apiPost("/api/automations", payload);
      toast.success("Automation created — review and enable it below.");
      onCreated();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e, "Failed to create automation"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New automation</DialogTitle>
          <DialogDescription>
            Describe which mail this agent should act on and what to do. It&apos;s created paused —
            you review and enable it afterwards.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} method="post" noValidate className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="automation-name">Name</Label>
            <Input
              id="automation-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="File supplier invoices"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="automation-action">Instruction</Label>
            <Textarea
              id="automation-action"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="Draft a supplier bill in Odoo from the attached invoice."
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              What the agent should do with each matching mail, in plain words. It runs with this
              agent&apos;s permissions and tools.
            </p>
          </div>

          <fieldset className="space-y-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">Trigger</legend>
            <p className="text-xs text-muted-foreground">
              Only mail matching every filled-in field runs the automation. Leave all blank to watch
              the entire mailbox.
            </p>
            <div className="space-y-2">
              <Label htmlFor="automation-from">From</Label>
              <Input
                id="automation-from"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="billing@acme.com, ap@acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="automation-to-domain">To domain</Label>
              <Input
                id="automation-to-domain"
                value={toDomain}
                onChange={(e) => setToDomain(e.target.value)}
                placeholder="acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="automation-subject">Subject contains</Label>
              <Input
                id="automation-subject"
                value={subjectContains}
                onChange={(e) => setSubjectContains(e.target.value)}
                placeholder="invoice, receipt"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="automation-has-attachment"
                checked={hasAttachment}
                onCheckedChange={(c) => setHasAttachment(c === true)}
              />
              <Label htmlFor="automation-has-attachment" className="font-normal">
                Has an attachment
              </Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="automation-attachment-type">Attachment type</Label>
              <Input
                id="automation-attachment-type"
                value={attachmentType}
                onChange={(e) => setAttachmentType(e.target.value)}
                placeholder="application/pdf"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="automation-folder">Folder</Label>
              <Input
                id="automation-folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="Inbox"
              />
            </div>
          </fieldset>

          <div className="space-y-2">
            <Label>Mailboxes</Label>
            <p className="text-xs text-muted-foreground">
              Which connected mailboxes this automation watches. Only mailboxes this agent may read
              are listed.
            </p>
            {loadingConnections ? (
              <div className="space-y-2">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-2/3" />
              </div>
            ) : connections.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                This agent has no readable email connection yet. Give it email read access to a
                connection first.
              </p>
            ) : (
              <div className="space-y-2">
                {connections.map((conn) => (
                  <div key={conn.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`automation-conn-${conn.id}`}
                      checked={selectedConnectionIds.includes(conn.id)}
                      onCheckedChange={(c) => toggleConnection(conn.id, c === true)}
                    />
                    <Label htmlFor={`automation-conn-${conn.id}`} className="font-normal">
                      {conn.name}
                    </Label>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="automation-sweep-window">Look back (days)</Label>
            <Input
              id="automation-sweep-window"
              type="number"
              min={1}
              max={365}
              value={sweepWindowDays}
              onChange={(e) => setSweepWindowDays(e.target.value)}
              className="w-28"
            />
            <p className="text-xs text-muted-foreground">
              How far back each pass re-checks for mail it may have missed.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Create automation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
