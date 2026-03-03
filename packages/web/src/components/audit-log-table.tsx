"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
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

const EVENT_TYPES = [
  "auth.login",
  "auth.failed",
  "auth.logout",
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "user.invited",
  "user.updated",
  "user.deleted",
  "config.changed",
  "tool.execute",
  "tool.denied",
];

function isNegativeEvent(eventType: string): boolean {
  return (
    eventType.includes("failed") || eventType.includes("deleted") || eventType.includes("denied")
  );
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
  return (
    <Link href="/settings" className="underline">
      {actorName}
    </Link>
  );
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
    return <span className="font-mono text-xs text-muted-foreground">{resource}</span>;
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
      <Link href={`/chat/${agentId}`} className="underline">
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
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  const fetchEntries = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      if (eventTypeFilter) {
        params.set("eventType", eventTypeFilter);
      }
      if (dateFrom) {
        params.set("from", dateFrom);
      }
      if (dateTo) {
        params.set("to", dateTo);
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
  }, [page, limit, eventTypeFilter, dateFrom, dateTo]);

  useEffect(() => {
    setLoading(true);
    fetchEntries();
  }, [fetchEntries]);

  async function handleExportCsv() {
    const res = await fetch("/api/audit/export");
    if (res.ok) {
      const csvText = await res.text();
      const blob = new Blob([csvText], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "audit-log.csv";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  }

  async function handleVerifyIntegrity() {
    setVerifyResult(null);
    const res = await fetch("/api/audit/verify");
    if (res.ok) {
      const data: VerifyResult = await res.json();
      setVerifyResult(data);
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

  function handleDateFromChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDateFrom(e.target.value);
    setPage(1);
  }

  function handleDateToChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDateTo(e.target.value);
    setPage(1);
  }

  function truncateDetail(detail: Record<string, unknown>): string {
    const str = JSON.stringify(detail);
    return str.length > 80 ? str.slice(0, 80) + "..." : str;
  }

  if (loading && entries.length === 0) {
    return <p>Loading...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <Select value={eventTypeFilter || "all"} onValueChange={handleEventTypeChange}>
            <SelectTrigger aria-label="Event Type" className="w-full sm:w-[200px]">
              <SelectValue placeholder="All Events" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Events</SelectItem>
              {EVENT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
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
              className="w-full sm:w-[160px]"
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="date-to" className="text-sm text-muted-foreground whitespace-nowrap">
              To
            </label>
            <Input
              id="date-to"
              type="date"
              value={dateTo}
              onChange={handleDateToChange}
              className="w-full sm:w-[160px]"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleVerifyIntegrity}>
            Verify Integrity
          </Button>
          <Button variant="outline" onClick={handleExportCsv}>
            Export CSV
          </Button>
        </div>
      </div>

      {verifyResult && (
        <div
          className={`rounded border p-3 text-sm ${
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
              {verifyResult.totalChecked} checked. IDs: {verifyResult.invalidIds.join(", ")}
            </span>
          )}
        </div>
      )}

      {entries.length === 0 ? (
        <p>No entries found.</p>
      ) : (
        <>
          {/* Mobile card-view */}
          <div className="block md:hidden space-y-2">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="rounded border p-3 space-y-1 cursor-pointer hover:bg-muted/50"
                onClick={() => setSelectedEntry(entry)}
              >
                <div className="flex items-center justify-between">
                  <Badge variant={isNegativeEvent(entry.eventType) ? "destructive" : "secondary"}>
                    {entry.eventType}
                  </Badge>
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
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Event Type</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow
                    key={entry.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setSelectedEntry(entry)}
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
                      <Badge
                        variant={isNegativeEvent(entry.eventType) ? "destructive" : "secondary"}
                      >
                        {entry.eventType}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <ResourceCell
                        resource={entry.resource}
                        resourceName={entry.resourceName}
                        resourceDeleted={entry.resourceDeleted}
                      />
                    </TableCell>
                    <TableCell className="max-w-[300px] truncate">
                      {truncateDetail(entry.detail)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
            <div className="p-4 space-y-4">
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
              <div>
                <p className="text-sm font-medium text-muted-foreground">Detail</p>
                <pre className="mt-1 rounded bg-muted p-3 text-sm overflow-auto">
                  {JSON.stringify(selectedEntry.detail, null, 2)}
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
