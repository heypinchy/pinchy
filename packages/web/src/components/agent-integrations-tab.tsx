"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";

const OPERATIONS = ["read", "create", "write", "delete"] as const;
type Operation = (typeof OPERATIONS)[number];

interface OdooModel {
  model: string;
  name: string;
}

interface Connection {
  id: string;
  name: string;
  type: string;
  data: { models?: OdooModel[] } | null;
}

interface PermissionRow {
  model: string;
  read: boolean;
  create: boolean;
  write: boolean;
  delete: boolean;
}

export interface IntegrationsValues {
  connectionId: string;
  permissions: Array<{ model: string; operation: string }>;
}

interface AgentIntegrationsTabProps {
  agentId: string;
  onChange: (values: IntegrationsValues | null, isDirty: boolean) => void;
}

export function AgentIntegrationsTab({ agentId, onChange }: AgentIntegrationsTabProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>("");
  const [permissionRows, setPermissionRows] = useState<Map<string, PermissionRow>>(new Map());
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  // Track initial state for dirty detection
  const initialPermissions = useRef<Set<string>>(new Set());
  const initialConnectionId = useRef<string>("");

  // Load connections and current permissions
  useEffect(() => {
    async function load() {
      try {
        const [connectionsRes, permsRes] = await Promise.all([
          fetch("/api/integrations"),
          fetch(`/api/agents/${agentId}/integrations`),
        ]);

        if (connectionsRes.ok) {
          const data = await connectionsRes.json();
          setConnections(data);
        }

        if (permsRes.ok) {
          const data = await permsRes.json();
          // If there are existing permissions, select that connection
          if (data.length > 0) {
            const connId = data[0].connectionId;
            setSelectedConnectionId(connId);
            initialConnectionId.current = connId;

            // Build permission rows from existing data
            const permSet = new Set<string>();
            const rows = new Map<string, PermissionRow>();
            for (const perm of data[0].permissions) {
              permSet.add(`${perm.model}:${perm.operation}`);
              if (!rows.has(perm.model)) {
                rows.set(perm.model, {
                  model: perm.model,
                  read: false,
                  create: false,
                  write: false,
                  delete: false,
                });
              }
              const row = rows.get(perm.model)!;
              if (OPERATIONS.includes(perm.operation as Operation)) {
                row[perm.operation as Operation] = true;
              }
            }
            initialPermissions.current = permSet;
            setPermissionRows(rows);
          }
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [agentId]);

  // Get models for selected connection
  const selectedConnection = useMemo(
    () => connections.find((c) => c.id === selectedConnectionId),
    [connections, selectedConnectionId]
  );

  const models = useMemo(() => {
    if (!selectedConnection?.data?.models) return [];
    return [...selectedConnection.data.models].sort((a, b) => a.name.localeCompare(b.name));
  }, [selectedConnection]);

  // Filter models
  const filteredModels = useMemo(() => {
    if (!filter) return models;
    const lowerFilter = filter.toLowerCase();
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(lowerFilter) || m.model.toLowerCase().includes(lowerFilter)
    );
  }, [models, filter]);

  // Build current permissions for onChange
  const buildPermissions = useCallback(
    (rows: Map<string, PermissionRow>): Array<{ model: string; operation: string }> => {
      const perms: Array<{ model: string; operation: string }> = [];
      for (const [model, row] of rows) {
        for (const op of OPERATIONS) {
          if (row[op]) {
            perms.push({ model, operation: op });
          }
        }
      }
      return perms;
    },
    []
  );

  // Notify parent of changes
  const notifyParent = useCallback(
    (connId: string, rows: Map<string, PermissionRow>) => {
      const perms = buildPermissions(rows);
      const currentSet = new Set(perms.map((p) => `${p.model}:${p.operation}`));

      const isDirty =
        connId !== initialConnectionId.current ||
        currentSet.size !== initialPermissions.current.size ||
        [...currentSet].some((k) => !initialPermissions.current.has(k));

      onChange(connId ? { connectionId: connId, permissions: perms } : null, isDirty);
    },
    [buildPermissions, onChange]
  );

  // Handle connection change
  function handleConnectionChange(connId: string) {
    setSelectedConnectionId(connId);
    // Reset permissions when switching connections (unless it's the initial one)
    if (connId !== initialConnectionId.current) {
      setPermissionRows(new Map());
      notifyParent(connId, new Map());
    } else {
      // Restore initial permissions
      // Re-fetch would be complex, so just notify with current state
      notifyParent(connId, permissionRows);
    }
  }

  // Toggle a single permission
  function handleToggle(modelId: string, operation: Operation) {
    setPermissionRows((prev) => {
      const next = new Map(prev);
      const row = next.get(modelId) ?? {
        model: modelId,
        read: false,
        create: false,
        write: false,
        delete: false,
      };
      const updated = { ...row, [operation]: !row[operation] };

      // Remove row if all false
      if (!updated.read && !updated.create && !updated.write && !updated.delete) {
        next.delete(modelId);
      } else {
        next.set(modelId, updated);
      }

      notifyParent(selectedConnectionId, next);
      return next;
    });
  }

  // Bulk operations
  function handleSelectAll(operation: Operation) {
    setPermissionRows((prev) => {
      const next = new Map(prev);
      for (const m of models) {
        const row = next.get(m.model) ?? {
          model: m.model,
          read: false,
          create: false,
          write: false,
          delete: false,
        };
        next.set(m.model, { ...row, [operation]: true });
      }
      notifyParent(selectedConnectionId, next);
      return next;
    });
  }

  function handleClearAll() {
    setPermissionRows(new Map());
    notifyParent(selectedConnectionId, new Map());
  }

  if (loading) {
    return <div className="text-muted-foreground py-4">Loading integrations...</div>;
  }

  if (connections.length === 0) {
    return (
      <div className="space-y-2 py-4">
        <p className="text-muted-foreground">No integration connections configured.</p>
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
        <label className="text-sm font-medium">Integration Connection</label>
        <Select value={selectedConnectionId} onValueChange={handleConnectionChange}>
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
      </div>

      {/* Permission matrix */}
      {selectedConnectionId && models.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Model Permissions</h3>

          <div className="flex items-center gap-3">
            <Input
              placeholder="Filter models..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-sm"
            />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Select All <ChevronDown className="ml-1 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {OPERATIONS.map((op) => (
                  <DropdownMenuItem key={op} onClick={() => handleSelectAll(op)}>
                    All {op.charAt(0).toUpperCase() + op.slice(1)}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onClick={handleClearAll}>Clear All</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Table header */}
          <div className="rounded-md border">
            <div className="grid grid-cols-[1fr_60px_60px_60px_60px] gap-2 border-b px-4 py-2 text-sm font-medium text-muted-foreground">
              <span>Model</span>
              <span className="text-center">Read</span>
              <span className="text-center">Create</span>
              <span className="text-center">Write</span>
              <span className="text-center">Delete</span>
            </div>

            {/* Table body */}
            <div className="max-h-[500px] overflow-y-auto">
              {filteredModels.map((m) => {
                const row = permissionRows.get(m.model);
                return (
                  <div
                    key={m.model}
                    className="grid grid-cols-[1fr_60px_60px_60px_60px] gap-2 border-b last:border-b-0 px-4 py-2 items-center"
                  >
                    <div>
                      <div className="text-sm font-medium">{m.name}</div>
                      <div className="text-xs text-muted-foreground">{m.model}</div>
                    </div>
                    {OPERATIONS.map((op) => (
                      <div key={op} className="flex justify-center">
                        <Checkbox
                          checked={row?.[op] ?? false}
                          onCheckedChange={() => handleToggle(m.model, op)}
                          aria-label={`${op} ${m.name}`}
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            Showing {filteredModels.length} of {models.length} models
          </p>
        </div>
      )}

      {selectedConnectionId && models.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No models available. Sync the connection schema in Settings &gt; Integrations first.
        </p>
      )}
    </div>
  );
}
