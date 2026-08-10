"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { apiGet, apiPost, apiPut, errorMessage } from "@/lib/api-client";
import { AUTOMATION_MAX_SWEEP_WINDOW_DAYS } from "@/lib/schemas/automations";
import type {
  AutomationConnectionOption,
  AutomationListItem,
  CreateAutomationInput,
  EditAutomationInput,
} from "@/lib/schemas/automations";
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

/** Split a comma-separated input into trimmed, non-empty tokens. */
function parseList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The form's field state seeded from an existing workflow (edit mode) or blank
 * (create mode). List filters become comma-joined strings — the inverse of
 * {@link parseList} — so what the form parses on submit round-trips what it
 * rendered. One function feeds both the initial state and the reset-on-reopen.
 */
function fieldsFromWorkflow(workflow?: AutomationListItem) {
  const filter = workflow?.filter ?? {};
  return {
    name: workflow?.name ?? "",
    action: workflow?.action ?? "",
    from: (filter.from ?? []).join(", "),
    toDomain: (filter.toDomain ?? []).join(", "),
    subjectContains: (filter.subjectContains ?? []).join(", "),
    hasAttachment: filter.hasAttachment ?? false,
    attachmentType: filter.attachmentType ?? "",
    folder: filter.folder ?? "",
    sweepWindowDays: String(workflow?.sweepWindowDays ?? DEFAULT_SWEEP_WINDOW_DAYS),
    selectedConnectionIds: workflow?.connectionIds ?? [],
  };
}

/**
 * The create/edit dialog for an Inbox Agent email workflow (#139). With no
 * `workflow` it authors a new one (POST /api/automations); given a `workflow` it
 * edits that one in place (PUT /api/automations/[id]). One form, because both
 * write the identical structured object — the edit path just starts pre-filled.
 * It shares the {@link CreateAutomationInput}/{@link EditAutomationInput}
 * contracts with the routes and the future conversational tool (#705).
 *
 * The mailbox picker is populated from GET /api/automations/connections, which
 * resolves choices through the same email-read permission gate the write routes
 * enforce — so the form can only offer mailboxes the server will accept.
 *
 * Propose, don't self-activate: neither path touches `enabled`/`status`. A new
 * workflow is written pending + disabled; an edit leaves activation exactly as it
 * was. There is no "enable now" control here — activation is the reviewer's
 * separate toggle in the tab.
 */
export function AgentSettingsAutomationDialog({
  agentId,
  open,
  onOpenChange,
  onSaved,
  workflow,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** When set, the dialog edits this workflow instead of creating a new one. */
  workflow?: AutomationListItem;
}) {
  const isEdit = workflow != null;

  const [connections, setConnections] = useState<AutomationConnectionOption[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  // How many mailboxes this workflow watched are no longer email-readable by the
  // agent (grant revoked after creation), so the picker can't offer them. We drop
  // them from the selection and tell the user, rather than let an invisible id
  // ride along on the PUT and come back a 400 for a mailbox they never saw.
  const [unavailableCount, setUnavailableCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // Monotonic sequence for connection loads: a response only lands if it still
  // belongs to the latest load, so a slow response from a previous open can
  // never clobber the picker a reopen just refreshed.
  const loadSeqRef = useRef(0);

  // Seed initial state from the workflow (edit) or blanks (create). Lazy so it
  // reads the workflow once, on mount — the mount-open case (open=true from the
  // first render) never fires the reset-on-open branch below, so the initial
  // state is what pre-fills an edit dialog opened directly.
  const [initial] = useState(() => fieldsFromWorkflow(workflow));
  const [name, setName] = useState(initial.name);
  const [action, setAction] = useState(initial.action);
  const [from, setFrom] = useState(initial.from);
  const [toDomain, setToDomain] = useState(initial.toDomain);
  const [subjectContains, setSubjectContains] = useState(initial.subjectContains);
  const [hasAttachment, setHasAttachment] = useState(initial.hasAttachment);
  const [attachmentType, setAttachmentType] = useState(initial.attachmentType);
  const [folder, setFolder] = useState(initial.folder);
  const [sweepWindowDays, setSweepWindowDays] = useState(initial.sweepWindowDays);
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<string[]>(
    initial.selectedConnectionIds
  );

  // Fresh form on each open (React-recommended "adjust state during render"
  // instead of an effect) — re-seeded from the current workflow so a reopened
  // edit dialog shows the stored values again. Also clears the picker and
  // re-arms loading so a reopen re-fetches rather than showing a stale list.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      const seed = fieldsFromWorkflow(workflow);
      setName(seed.name);
      setAction(seed.action);
      setFrom(seed.from);
      setToDomain(seed.toDomain);
      setSubjectContains(seed.subjectContains);
      setHasAttachment(seed.hasAttachment);
      setAttachmentType(seed.attachmentType);
      setFolder(seed.folder);
      setSweepWindowDays(seed.sweepWindowDays);
      setSelectedConnectionIds(seed.selectedConnectionIds);
      setConnections([]);
      setConnectionsError(null);
      setUnavailableCount(0);
      setLoadingConnections(true);
    }
  }

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoadingConnections(true);
    setConnectionsError(null);
    try {
      const data = await apiGet<AutomationConnectionOption[]>(
        `/api/automations/connections?agentId=${encodeURIComponent(agentId)}`
      );
      if (seq !== loadSeqRef.current) return;
      const options = Array.isArray(data) ? data : [];
      setConnections(options);
      // Any mailbox this workflow watched that the options don't offer is one the
      // agent can no longer read. Prune those ids from the selection so they
      // never reach the PUT (which would 400 on them), and surface the count.
      const optionIds = new Set(options.map((c) => c.id));
      const unavailable = (workflow?.connectionIds ?? []).filter((id) => !optionIds.has(id));
      setUnavailableCount(unavailable.length);
      if (unavailable.length > 0) {
        const gone = new Set(unavailable);
        setSelectedConnectionIds((prev) => prev.filter((id) => !gone.has(id)));
      }
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setConnections([]);
      // Rendered inline (with a retry) instead of a toast: an empty picker after
      // a failed load must not look like "this agent has no mailboxes".
      setConnectionsError(errorMessage(e, "Failed to load mailboxes"));
    } finally {
      if (seq === loadSeqRef.current) setLoadingConnections(false);
    }
  }, [agentId, workflow]);

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

  // Validated against the exact bounds the server schema enforces
  // (1..AUTOMATION_MAX_SWEEP_WINDOW_DAYS): out-of-range input blocks the submit
  // with a hint instead of a server 400, and is never silently replaced by the
  // default. Only a genuinely blank field means "use the default".
  const sweepTrimmed = sweepWindowDays.trim();
  const parsedSweepDays = sweepTrimmed === "" ? DEFAULT_SWEEP_WINDOW_DAYS : Number(sweepTrimmed);
  const sweepWindowValid =
    Number.isInteger(parsedSweepDays) &&
    parsedSweepDays >= 1 &&
    parsedSweepDays <= AUTOMATION_MAX_SWEEP_WINDOW_DAYS;

  const canSubmit =
    name.trim().length > 0 &&
    action.trim().length > 0 &&
    selectedConnectionIds.length > 0 &&
    sweepWindowValid &&
    !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      if (workflow) {
        // Edit: replace the workflow's editable representation. No agentId — a
        // workflow never changes agents; no enabled — activation stays the tab's
        // toggle.
        const payload: EditAutomationInput = {
          name: name.trim(),
          action: action.trim(),
          filter: buildFilter(),
          connectionIds: selectedConnectionIds,
          sweepWindowDays: parsedSweepDays,
        };
        await apiPut(`/api/automations/${workflow.id}`, payload);
        toast.success("Automation updated.");
      } else {
        const payload: CreateAutomationInput = {
          agentId,
          name: name.trim(),
          action: action.trim(),
          filter: buildFilter(),
          connectionIds: selectedConnectionIds,
          sweepWindowDays: parsedSweepDays,
        };
        await apiPost("/api/automations", payload);
        toast.success("Automation created — review and enable it below.");
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(
        errorMessage(e, isEdit ? "Failed to update automation" : "Failed to create automation")
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit automation" : "New automation"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Change which mail this agent acts on and what it does. Saving doesn't change whether it's enabled — use the toggle in the list for that."
              : "Describe which mail this agent should act on and what to do. It's created paused — you review and enable it afterwards."}
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
            {!loadingConnections && !connectionsError && unavailableCount > 0 && (
              <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                {unavailableCount === 1
                  ? "1 mailbox this automation watched is no longer readable by this agent and has been removed from the selection. Saving will stop watching it."
                  : `${unavailableCount} mailboxes this automation watched are no longer readable by this agent and have been removed from the selection. Saving will stop watching them.`}
              </p>
            )}
            {loadingConnections ? (
              <div className="space-y-2">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-2/3" />
              </div>
            ) : connectionsError ? (
              <div className="space-y-2 rounded-md border border-destructive/50 p-3">
                <p className="text-sm text-destructive">{connectionsError}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                  Try again
                </Button>
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
              max={AUTOMATION_MAX_SWEEP_WINDOW_DAYS}
              value={sweepWindowDays}
              onChange={(e) => setSweepWindowDays(e.target.value)}
              className="w-28"
            />
            {!sweepWindowValid && (
              <p className="text-xs text-destructive">
                Enter a whole number of days between 1 and {AUTOMATION_MAX_SWEEP_WINDOW_DAYS}.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              How far back each pass re-checks for mail it may have missed.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isEdit ? "Save changes" : "Create automation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
