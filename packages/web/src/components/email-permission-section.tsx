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

/** The email operations in display order. */
const EMAIL_OPERATIONS = ["read", "draft", "send"] as const;
type EmailOperation = (typeof EMAIL_OPERATIONS)[number];

/** Connection types that are email-related. */
const EMAIL_CONNECTION_TYPES = new Set(["google", "microsoft", "imap"]);

interface Connection {
  id: string;
  name: string;
  type: string;
  data: unknown;
}

interface EmailPermissionSectionProps {
  agentId: string;
  onChange: (
    values: {
      connectionId: string;
      permissions: Array<{ model: string; operation: string }>;
    } | null,
    isDirty: boolean
  ) => void;
}

export function EmailPermissionSection({ agentId, onChange }: EmailPermissionSectionProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [operations, setOperations] = useState<Record<EmailOperation, boolean>>({
    read: false,
    draft: false,
    send: false,
  });
  const [loading, setLoading] = useState(true);

  // Track initial state for dirty detection
  const initialConnectionId = useRef("");
  const initialPermissions = useRef<Set<string>>(new Set());

  // Stable ref for onChange to avoid infinite re-render loops
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Load connections and existing permissions
  useEffect(() => {
    async function load() {
      try {
        const [connectionsRes, permsRes] = await Promise.all([
          fetch("/api/integrations"),
          fetch(`/api/agents/${agentId}/integrations`),
        ]);

        let allConnections: Connection[] = [];
        if (connectionsRes.ok) {
          allConnections = await connectionsRes.json();
        }

        // Filter to email-type connections only
        const emailConnections = allConnections.filter((c) => EMAIL_CONNECTION_TYPES.has(c.type));
        setConnections(emailConnections);

        if (permsRes.ok) {
          const data = await permsRes.json();
          // Find existing email permissions (look for a connection that matches an email type)
          for (const entry of data) {
            const matchingConn = emailConnections.find((c) => c.id === entry.connectionId);
            if (matchingConn) {
              setConnectionId(entry.connectionId);
              initialConnectionId.current = entry.connectionId;

              const ops: Record<EmailOperation, boolean> = {
                read: false,
                draft: false,
                send: false,
              };
              const permSet = new Set<string>();

              for (const perm of entry.permissions) {
                if (
                  perm.model === "email" &&
                  EMAIL_OPERATIONS.includes(perm.operation as EmailOperation)
                ) {
                  ops[perm.operation as EmailOperation] = true;
                  permSet.add(`email:${perm.operation}`);
                }
              }

              initialPermissions.current = permSet;
              setOperations(ops);
              break;
            }
          }
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [agentId]);

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

    // No operations enabled and none initially → not dirty
    const hasAny = EMAIL_OPERATIONS.some((op) => operations[op]);
    if (!hasAny && initialPermissions.current.size === 0) return false;

    if (connectionId !== initialConnectionId.current) return true;

    const currentSet = new Set<string>();
    for (const op of EMAIL_OPERATIONS) {
      if (operations[op]) {
        currentSet.add(`email:${op}`);
      }
    }

    if (currentSet.size !== initialPermissions.current.size) return true;
    for (const key of currentSet) {
      if (!initialPermissions.current.has(key)) return true;
    }
    return false;
  }, [loading, connectionId, operations]);

  // Notify parent of changes
  useEffect(() => {
    if (loading) return;
    const perms = getPermissions();
    const hasConfig = connectionId && perms.length > 0;
    onChangeRef.current(hasConfig ? { connectionId, permissions: perms } : null, isDirty);
  }, [connectionId, operations, loading, getPermissions, isDirty]);

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

  if (connections.length === 0) {
    return (
      <div className="space-y-2 py-4">
        <p className="text-muted-foreground">No email connections configured.</p>
        <p className="text-sm text-muted-foreground">
          Go to{" "}
          <a href="/settings?tab=integrations" className="underline hover:text-foreground">
            Settings &gt; Integrations
          </a>{" "}
          to add a connection first.
        </p>
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
