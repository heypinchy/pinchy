"use client";

import { useState, useEffect, useCallback } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-json";
import "./json-highlight.css";
import Link from "next/link";
import { CircleCheck, CircleX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

interface AuditEntry {
  id: number;
  timestamp: string;
  actorType: string;
  actorId: string;
  actorName: string | null;
  actorDeleted: boolean;
  eventType: string;
  resource: string | null;
  resourceName: string | null;
  resourceDeleted: boolean;
  detail: Record<string, unknown>;
  rowHmac: string;
  version: number;
  outcome: "success" | "failure" | null;
  error: { message: string } | null;
}

function StatusCell({ outcome }: { outcome: "success" | "failure" | null }) {
  if (outcome === null) {
    return (
      <span
        aria-label="Not tracked"
        title="Logged before status tracking"
        className="text-muted-foreground"
      >
        —
      </span>
    );
  }
  if (outcome === "success")
    return <CircleCheck aria-label="Success" className="h-4 w-4 text-green-600" />;
  return <CircleX aria-label="Failure" className="h-4 w-4 text-red-600" />;
}

interface AuditResponse {
  entries: AuditEntry[];
  total: number;
  page: number;
  limit: number;
}

interface VerifyResult {
  valid: boolean;
  totalChecked: number;
  invalidIds: number[];
}

// Convert a date-only string (YYYY-MM-DD) to a UTC ISO string at local midnight / end of day,
// so that filters respect the user's browser timezone rather than UTC.
function localDateStart(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day).toISOString();
}

function localDateEnd(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
}

function highlightJson(json: string): string {
  if (!Prism.languages.json) {
    return json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  return Prism.highlight(json, Prism.languages.json, "json");
}

function ActorCell({
  actorId,
  actorName,
  actorDeleted,
}: {
  actorId: string;
  actorName: string | null;
  actorDeleted: boolean;
}) {
  if (!actorName)
    return <span className="font-mono text-xs text-muted-foreground">{actorId.slice(0, 8)}…</span>;
  if (actorDeleted)
    return (
      <span>
        {actorName}{" "}
        <Badge variant="outline" className="text-xs ml-1">
          deactivated
        </Badge>
      </span>
    );
  return <span>{actorName}</span>;
}

function ResourceCell({
  resource,
  resourceName,
  resourceDeleted,
}: {
  resource: string | null;
  resourceName: string | null;
  resourceDeleted: boolean;
}) {
  if (!resource) return <span>-</span>;
  if (!resourceName)
    return (
      <span className="font-mono text-xs text-muted-foreground">
        {resource.length > 30 ? resource.slice(0, 30) + "…" : resource}
      </span>
    );
  if (resourceDeleted)
    return (
      <span>
        {resourceName}{" "}
        <Badge variant="outline" className="text-xs ml-1">
          deleted
        </Badge>
      </span>
    );
  const agentId = resource.startsWith("agent:") ? resource.slice(6) : null;
  if (agentId)
    return (
      <Link href={`/chat/${agentId}`} className="underline" onClick={(e) => e.stopPropagation()}>
        {resourceName}
      </Link>
    );
  return <span>{resourceName}</span>;
}

export function AuditLogTable() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"" | "success" | "failure">("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [availableEventTypes, setAvailableEventTypes] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/audit/event-types")
      .then((res) => res.json())
      .then((data: { eventTypes: string[] }) => setAvailableEventTypes(data.eventTypes))
      .catch(() => {});
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  const fetchEntries = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      if (eventTypeFilter) {
        params.set("eventType", eventTypeFilter);
      }
      if (statusFilter) {
        params.set("status", statusFilter);
      }
      if (dateFrom) {
        params.set("from", localDateStart(dateFrom));
      }
      if (dateTo) {
        params.set("to", localDateEnd(dateTo));
      }

      const res = await fetch(`/api/audit?${params.toString()}`);
      if (res.ok) {
        const data: AuditResponse = await res.json();
        setEntries(data.entries);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [page, limit, eventTypeFilter, statusFilter, dateFrom, dateTo]);

  useEffect(() => {
    setLoading(true);
    fetchEntries();
  }, [fetchEntries]);

  async function handleExport(format: "csv" | "pdf") {
    const params = new URLSearchParams();
    params.set("format", format);
    if (eventTypeFilter) params.set("eventType", eventTypeFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (dateFrom) params.set("from", localDateStart(dateFrom));
    if (dateTo) params.set("to", localDateEnd(dateTo));
    const res = await fetch(`/api/audit/export?${params.toString()}`);
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `audit-log.${format}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  }

  async function handleVerifyIntegrity() {
    setVerifyResult(null);
    setVerifying(true);
    try {
      const res = await fetch("/api/audit/verify");
      if (res.ok) {
        const data: VerifyResult = await res.json();
        setVerifyResult(data);
      }
    } finally {
      setVerifying(false);
    }
  }

  function handlePrevious() {
    if (page > 1) {
      setPage(page - 1);
    }
  }

  function handleNext() {
    if (page < totalPages) {
      setPage(page + 1);
    }
  }

  function handleEventTypeChange(value: string) {
    setEventTypeFilter(value === "all" ? "" : value);
    setPage(1);
  }

  function handleStatusChange(value: string) {
    setStatusFilter(value === "all" ? "" : (value as "success" | "failure"));
    setPage(1);
  }

  function handleDateFromChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDateFrom(e.target.value);
    setPage(1);
  }

  function handleDateToChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDateTo(e.target.value);
    setPage(1);
  }

  const tamperedIds = verifyResult && !verifyResult.valid ? new Set(verifyResult.invalidIds) : null;

  if (loading && entries.length === 0) {
    return <p>Loading...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Audit Trail</h1>
        <Button
          variant="outline"
          onClick={handleVerifyIntegrity}
          disabled={verifying}
          className="shrink-0"
        >
          {verifying ? "Verifying…" : "Verify Integrity"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={eventTypeFilter || "all"} onValueChange={handleEventTypeChange}>
            <SelectTrigger aria-label="Event Type" className="w-[200px]">
              <SelectValue placeholder="All Events" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Events</SelectItem>
              {availableEventTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter || "all"} onValueChange={handleStatusChange}>
            <SelectTrigger aria-label="Status" className="w-[160px]">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="success">Success only</SelectItem>
              <SelectItem value="failure">Failures only</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <label htmlFor="date-from" className="text-sm text-muted-foreground whitespace-nowrap">
              From
            </label>
            <Input
              id="date-from"
              type="date"
              value={dateFrom}
              onChange={handleDateFromChange}
              className="w-[160px]"
            />
            <label htmlFor="date-to" className="text-sm text-muted-foreground whitespace-nowrap">
              To
            </label>
            <Input
              id="date-to"
              type="date"
              value={dateTo}
              onChange={handleDateToChange}
              className="w-[160px]"
            />
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Export</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => handleExport("csv")}>Export as CSV</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleExport("pdf")}>Export as PDF</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {verifyResult && (
        <div
          className={`rounded border p-3 text-sm flex items-center justify-between gap-3 ${
            verifyResult.valid
              ? "border-green-500 bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200"
              : "border-red-500 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
          }`}
        >
          {verifyResult.valid ? (
            <span>All {verifyResult.totalChecked} entries verified. Integrity intact.</span>
          ) : (
            <span>
              {verifyResult.invalidIds.length} tampered entries detected out of{" "}
              {verifyResult.totalChecked} checked. Tampered entries are highlighted in the table
              below.
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Dismiss"
            className="shrink-0 size-6 p-0 hover:bg-black/10 dark:hover:bg-white/10"
            onClick={() => setVerifyResult(null)}
          >
            ×
          </Button>
        </div>
      )}

      {entries.length === 0 ? (
        <p>No entries found.</p>
      ) : (
        <>
          {/* Mobile card-view */}
          <div className="block lg:hidden space-y-2">
            {entries.map((entry) => (
              <div
                key={entry.id}
                role="button"
                tabIndex={0}
                className={`rounded border p-3 space-y-1 cursor-pointer hover:bg-muted/50 ${tamperedIds?.has(entry.id) ? "border-red-400 bg-red-50 dark:bg-red-950/20" : ""}`}
                data-tampered={tamperedIds?.has(entry.id) ? "true" : undefined}
                onClick={() => setSelectedEntry(entry)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === " ") e.preventDefault();
                }}
                onKeyUp={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") setSelectedEntry(entry);
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{entry.eventType}</Badge>
                    <StatusCell outcome={entry.outcome} />
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(entry.timestamp).toLocaleString()}
                  </span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Actor: </span>
                  <ActorCell
                    actorId={entry.actorId}
                    actorName={entry.actorName}
                    actorDeleted={entry.actorDeleted}
                  />
                </div>
                {entry.resource && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Resource: </span>
                    <ResourceCell
                      resource={entry.resource}
                      resourceName={entry.resourceName}
                      resourceDeleted={entry.resourceDeleted}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden lg:block">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Event Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Resource</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => (
                    <TableRow
                      key={entry.id}
                      className={`cursor-pointer hover:bg-muted/50 ${tamperedIds?.has(entry.id) ? "bg-red-50 dark:bg-red-950/20" : ""}`}
                      data-tampered={tamperedIds?.has(entry.id) ? "true" : undefined}
                      tabIndex={0}
                      onClick={() => setSelectedEntry(entry)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === " ") e.preventDefault();
                      }}
                      onKeyUp={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") setSelectedEntry(entry);
                      }}
                    >
                      <TableCell>{new Date(entry.timestamp).toLocaleString()}</TableCell>
                      <TableCell>
                        <ActorCell
                          actorId={entry.actorId}
                          actorName={entry.actorName}
                          actorDeleted={entry.actorDeleted}
                        />
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{entry.eventType}</Badge>
                      </TableCell>
                      <TableCell>
                        <StatusCell outcome={entry.outcome} />
                      </TableCell>
                      <TableCell>
                        <ResourceCell
                          resource={entry.resource}
                          resourceName={entry.resourceName}
                          resourceDeleted={entry.resourceDeleted}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={handlePrevious} disabled={page <= 1}>
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button variant="outline" onClick={handleNext} disabled={page >= totalPages}>
              Next
            </Button>
          </div>
        </>
      )}

      <Sheet open={!!selectedEntry} onOpenChange={(open) => !open && setSelectedEntry(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Entry Detail</SheetTitle>
            <SheetDescription>Full audit log entry information</SheetDescription>
          </SheetHeader>
          {selectedEntry && (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Timestamp</p>
                <p>{new Date(selectedEntry.timestamp).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Actor</p>
                <p>
                  {selectedEntry.actorType}:{" "}
                  <ActorCell
                    actorId={selectedEntry.actorId}
                    actorName={selectedEntry.actorName}
                    actorDeleted={selectedEntry.actorDeleted}
                  />
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Event Type</p>
                <p>{selectedEntry.eventType}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Resource</p>
                <ResourceCell
                  resource={selectedEntry.resource}
                  resourceName={selectedEntry.resourceName}
                  resourceDeleted={selectedEntry.resourceDeleted}
                />
              </div>
              {selectedEntry.outcome === "failure" && selectedEntry.error && (
                <div className="rounded border border-red-500 bg-red-50 dark:bg-red-950 dark:text-red-200 p-3">
                  <p className="text-sm font-medium text-red-800 dark:text-red-200 flex items-center gap-2">
                    <CircleX className="h-4 w-4" />
                    Tool call failed
                  </p>
                  <p className="mt-1 text-sm text-red-800 dark:text-red-200">
                    {selectedEntry.error.message}
                  </p>
                </div>
              )}
              <div>
                <p className="text-sm font-medium text-muted-foreground">Detail</p>
                <pre className="mt-1 rounded bg-muted p-3 text-sm overflow-auto json-highlight">
                  <code
                    dangerouslySetInnerHTML={{
                      __html: highlightJson(JSON.stringify(selectedEntry.detail, null, 2)),
                    }}
                  />
                </pre>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Row HMAC</p>
                <p className="text-xs font-mono break-all">{selectedEntry.rowHmac}</p>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
