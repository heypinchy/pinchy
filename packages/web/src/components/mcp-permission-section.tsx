"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import type { McpIntegrationData } from "@/lib/integrations/types";

// ── Types ─────────────────────────────────────────────────────────────────────

interface McpConnection {
  id: string;
  name: string;
  type: "mcp";
  status?: string;
  data?: McpIntegrationData;
}

/** One entry per MCP connection in the GET response. */
interface McpPermissionEntry {
  kind: "mcp";
  connectionId: string;
  connectionName: string;
  availableTools: string[];
  tools: string[]; // currently granted tool names
}

interface DriftEntry {
  connectionName: string;
  removedTool: string;
}

/** What we pass up to the parent via onChange. */
export interface McpIntegrationValue {
  kind: "mcp";
  connectionId: string;
  tools: string[];
}

interface McpPermissionSectionProps {
  agentId: string;
  connections: McpConnection[];
  onChange: (values: McpIntegrationValue[], isDirty: boolean) => void;
}

// ── Per-connection tool state ─────────────────────────────────────────────────

interface ConnectionState {
  connectionId: string;
  connectionName: string;
  availableTools: string[];
  checkedTools: Set<string>;
  initialTools: Set<string>;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function McpPermissionSection({
  agentId,
  connections,
  onChange,
}: McpPermissionSectionProps) {
  const [connectionStates, setConnectionStates] = useState<ConnectionState[]>([]);
  const [loading, setLoading] = useState(true);

  // Track which drift keys have already been toasted so re-renders don't repeat them
  const shownDriftKeys = useRef<Set<string>>(new Set());

  // Stable ref for onChange to avoid stale closure issues
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Load existing permissions from the server
  useEffect(() => {
    if (connections.length === 0) {
      setLoading(false);
      return;
    }

    async function load() {
      try {
        const res = await fetch(`/api/agents/${agentId}/integrations`);
        if (!res.ok) {
          setLoading(false);
          return;
        }

        const data = await res.json();

        // data can be:
        //   { permissions: [...], drift: [...] }  (new shape)
        //   [...] (legacy shape — treat as empty)
        const permissions: McpPermissionEntry[] = Array.isArray(data)
          ? []
          : (data.permissions ?? []).filter((p: { kind: string }) => p.kind === "mcp");
        const drift: DriftEntry[] = Array.isArray(data) ? [] : (data.drift ?? []);

        // Build per-connection state
        const states: ConnectionState[] = connections.map((conn) => {
          const serverEntry = permissions.find((p) => p.connectionId === conn.id);
          const availableTools =
            serverEntry?.availableTools ?? (conn.data?.tools ?? []).map((t) => t.name);
          const grantedTools = new Set<string>(serverEntry?.tools ?? []);

          return {
            connectionId: conn.id,
            connectionName: conn.name,
            availableTools,
            checkedTools: new Set(grantedTools),
            initialTools: new Set(grantedTools),
          };
        });

        setConnectionStates(states);

        // Show drift toasts (one per entry, deduplicated via ref)
        for (const entry of drift) {
          const key = `${entry.connectionName}:${entry.removedTool}`;
          if (!shownDriftKeys.current.has(key)) {
            shownDriftKeys.current.add(key);
            toast("Tool removed", {
              description: `Tool \`${entry.removedTool}\` is no longer provided by ${entry.connectionName} and was removed from this agent.`,
            });
          }
        }
      } finally {
        setLoading(false);
      }
    }

    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]); // intentionally only re-run when agentId changes, not connections

  // Compute values and notify parent whenever connectionStates changes
  const notifyParent = useCallback((states: ConnectionState[]) => {
    const values: McpIntegrationValue[] = states.map((s) => ({
      kind: "mcp",
      connectionId: s.connectionId,
      tools: Array.from(s.checkedTools),
    }));

    const isDirty = states.some((s) => {
      if (s.checkedTools.size !== s.initialTools.size) return true;
      for (const tool of s.checkedTools) {
        if (!s.initialTools.has(tool)) return true;
      }
      return false;
    });

    onChangeRef.current(values, isDirty);
  }, []);

  useEffect(() => {
    if (!loading) {
      notifyParent(connectionStates);
    }
  }, [connectionStates, loading, notifyParent]);

  function handleToolToggle(connectionId: string, tool: string) {
    setConnectionStates((prev) =>
      prev.map((s) => {
        if (s.connectionId !== connectionId) return s;
        const next = new Set(s.checkedTools);
        if (next.has(tool)) {
          next.delete(tool);
        } else {
          next.add(tool);
        }
        return { ...s, checkedTools: next };
      })
    );
  }

  if (connections.length === 0) return null;
  if (loading) return null;

  return (
    <>
      {connectionStates.map((state) => (
        <section key={state.connectionId} className="space-y-4">
          <h3 className="text-lg font-semibold">{state.connectionName}</h3>
          <div className="space-y-3">
            {state.availableTools.map((tool) => (
              <div key={tool} className="flex items-center space-x-3">
                <Checkbox
                  id={`mcp-tool-${state.connectionId}-${tool}`}
                  checked={state.checkedTools.has(tool)}
                  onCheckedChange={() => handleToolToggle(state.connectionId, tool)}
                  aria-label={tool}
                />
                <Label
                  htmlFor={`mcp-tool-${state.connectionId}-${tool}`}
                  className="cursor-pointer"
                >
                  <span className="font-medium">{tool}</span>
                </Label>
              </div>
            ))}
            {state.availableTools.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No tools available. Sync the connection in Settings &gt; Integrations first.
              </p>
            )}
          </div>
        </section>
      ))}
    </>
  );
}
