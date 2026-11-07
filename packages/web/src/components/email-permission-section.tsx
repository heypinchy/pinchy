"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { EMAIL_OPERATIONS, type EmailOperation } from "@/lib/tool-registry";
import { apiGet, errorMessage } from "@/lib/api-client";

// ── Email-specific display names ─────────────────────────────────────────

const EMAIL_MODEL_NAMES: Record<string, string> = {
  email: "Email",
  calendar: "Calendar", // future
  drive: "Drive", // future
  contacts: "Contacts", // future
};

const EMAIL_OPERATION_NAMES: Record<string, string> = {
  read: "Read messages",
  draft: "Create drafts",
  send: "Send messages",
};

interface Connection {
  id: string;
  name: string;
  type: string;
  status?: string;
  data?: unknown;
}

/** One row of `GET /api/agents/:id/integrations`. */
interface AgentIntegrationEntry {
  connectionId: string;
  permissions: Array<{ model: string; operation: string }>;
}

interface EmailPermissionSectionProps {
  agentId: string;
  connections: Connection[];
  onChange: (
    values: {
      connectionId: string;
      permissions: Array<{ model: string; operation: string }>;
    } | null,
    isDirty: boolean
  ) => void;
}

export function EmailPermissionSection({
  agentId,
  connections,
  onChange,
}: EmailPermissionSectionProps) {
  const [connectionId, setConnectionId] = useState("");
  const [operations, setOperations] = useState<Record<EmailOperation, boolean>>({
    read: false,
    draft: false,
    send: false,
  });
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // Track initial state for dirty detection
  const [initialConnectionId, setInitialConnectionId] = useState("");
  const [initialPermissions, setInitialPermissions] = useState<Set<string>>(new Set());

  // Stable ref for onChange to avoid infinite re-render loops
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Load existing agent permissions for these connections
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const data = await apiGet<AgentIntegrationEntry[]>(`/api/agents/${agentId}/integrations`, {
          signal,
        });
        if (signal.aborted) return;
        setLoadFailed(false);
        for (const entry of data) {
          const matchingConn = connections.find((c) => c.id === entry.connectionId);
          if (matchingConn) {
            setConnectionId(entry.connectionId);
            setInitialConnectionId(entry.connectionId);

            const ops: Record<EmailOperation, boolean> = {
              read: false,
              draft: false,
              send: false,
            };
            const permSet = new Set<string>();

            for (const perm of entry.permissions) {
              if (perm.model !== "email") continue;

              // Legacy alias: pre-#328 agent template creation could persist
              // a standalone "search" or "list" row with NO accompanying
              // "read" row (see tool-registry.ts EMAIL_OPERATIONS comment).
              // The runtime (getEmailToolsForOperations / checkPermission)
              // treats both as granting the full "read" toolset, so the
              // checkbox must reflect that effective grant — otherwise it
              // renders unchecked while read tools are actually enabled,
              // and a save would silently revoke read by writing back only
              // the checked operations.
              const normalizedOp =
                perm.operation === "search" || perm.operation === "list" ? "read" : perm.operation;

              if (EMAIL_OPERATIONS.includes(normalizedOp as EmailOperation)) {
                ops[normalizedOp as EmailOperation] = true;
                permSet.add(`email:${normalizedOp}`);
              }
            }

            setInitialPermissions(permSet);
            setOperations(ops);
            break;
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        // An empty editor here would read as "no email access", and saving
        // from it would replace the real grants — so there is no editor.
        setLoadFailed(true);
        toast.error(
          errorMessage(
            err,
            "Couldn't load this agent's email permissions. Try refreshing the page."
          )
        );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [agentId, connections]);

  // Compute permissions array from current state
  const getPermissions = useCallback((): Array<{ model: string; operation: string }> => {
    const perms: Array<{ model: string; operation: string }> = [];
    for (const op of EMAIL_OPERATIONS) {
      if (operations[op]) {
        perms.push({ model: "email", operation: op });
      }
    }
    return perms;
  }, [operations]);

  // Compute dirty state
  const isDirty = useMemo(() => {
    if (loading) return false;

    const hasAny = EMAIL_OPERATIONS.some((op) => operations[op]);
    if (!hasAny && initialPermissions.size === 0) return false;

    if (connectionId !== initialConnectionId) return true;

    const currentSet = new Set<string>();
    for (const op of EMAIL_OPERATIONS) {
      if (operations[op]) {
        currentSet.add(`email:${op}`);
      }
    }

    if (currentSet.size !== initialPermissions.size) return true;
    for (const key of currentSet) {
      if (!initialPermissions.has(key)) return true;
    }
    return false;
  }, [loading, connectionId, operations, initialConnectionId, initialPermissions]);

  // Notify parent of changes
  useEffect(() => {
    if (loading || loadFailed) return;
    const perms = getPermissions();
    const hasConfig = connectionId && perms.length > 0;
    onChangeRef.current(hasConfig ? { connectionId, permissions: perms } : null, isDirty);
  }, [connectionId, operations, loading, loadFailed, getPermissions, isDirty]);

  function handleConnectionChange(id: string) {
    setConnectionId(id);
    setOperations({ read: false, draft: false, send: false });
  }

  function handleClearConnection() {
    setConnectionId("");
    setOperations({ read: false, draft: false, send: false });
  }

  function handleToggleOperation(op: EmailOperation) {
    setOperations((prev) => ({ ...prev, [op]: !prev[op] }));
  }

  if (loading) {
    return <div className="text-muted-foreground py-4">Loading email configuration...</div>;
  }

  if (loadFailed) {
    return (
      <div className="text-muted-foreground py-4">
        This agent&apos;s email permissions could not be loaded.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Connection selector */}
      <div className="space-y-2">
        <Label>Connection</Label>
        <div className="flex items-center gap-2">
          <Select value={connectionId} onValueChange={handleConnectionChange}>
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder="Select a connection..." />
            </SelectTrigger>
            <SelectContent>
              {connections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id}>
                  {conn.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {connectionId && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={handleClearConnection}
              aria-label="Clear connection"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Permission matrix */}
      {connectionId && (
        <div className="space-y-4">
          <div className="rounded-md border">
            {/* Header */}
            <div className="grid grid-cols-[1fr_repeat(3,100px)] gap-2 border-b px-4 py-2 text-sm font-medium text-muted-foreground">
              <span>Model</span>
              {EMAIL_OPERATIONS.map((op) => (
                <span key={op} className="text-center">
                  {EMAIL_OPERATION_NAMES[op]}
                </span>
              ))}
            </div>

            {/* Email row */}
            <div className="grid grid-cols-[1fr_repeat(3,100px)] gap-2 px-4 py-2 items-center">
              <div className="text-sm font-medium">{EMAIL_MODEL_NAMES.email}</div>
              {EMAIL_OPERATIONS.map((op) => (
                <div key={op} className="flex justify-center">
                  <Checkbox
                    checked={operations[op]}
                    onCheckedChange={() => handleToggleOperation(op)}
                    aria-label={`${op} email`}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
