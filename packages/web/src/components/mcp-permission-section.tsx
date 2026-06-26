"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Search } from "lucide-react";
import type { McpIntegrationData } from "@/lib/integrations/types";
import {
  groupMcpTools,
  filterMcpTools,
  type McpToolInfo,
} from "@/lib/integrations/mcp-tool-groups";

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
  availableTools: McpToolInfo[];
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
  availableTools: McpToolInfo[];
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
  // Per-connection search query (connectionId → query).
  const [searchByConn, setSearchByConn] = useState<Record<string, string>>({});

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
          const availableTools: McpToolInfo[] =
            serverEntry?.availableTools ??
            (conn.data?.tools ?? []).map((t) => ({
              name: t.name,
              description: t.description ?? "",
            }));
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

  // Select/deselect all tools in a group at once. Callers pass the currently
  // VISIBLE (filtered) tool names, so "select all" with an active search only
  // touches what's on screen.
  function handleGroupToggle(connectionId: string, toolNames: string[], checked: boolean) {
    setConnectionStates((prev) =>
      prev.map((s) => {
        if (s.connectionId !== connectionId) return s;
        const next = new Set(s.checkedTools);
        for (const name of toolNames) {
          if (checked) next.add(name);
          else next.delete(name);
        }
        return { ...s, checkedTools: next };
      })
    );
  }

  if (connections.length === 0) return null;
  if (loading) return null;

  return (
    <>
      {connectionStates.map((state) => {
        const query = searchByConn[state.connectionId] ?? "";
        const filtered = filterMcpTools(state.availableTools, query);
        const groups = groupMcpTools(filtered);
        const selectedCount = state.checkedTools.size;
        const totalCount = state.availableTools.length;

        return (
          <section key={state.connectionId} className="space-y-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-lg font-semibold">{state.connectionName}</h3>
              <span className="text-sm text-muted-foreground">
                {selectedCount} of {totalCount} tools enabled
              </span>
            </div>

            {totalCount === 0 ? (
              <p className="text-sm text-muted-foreground">
                No tools available. Sync the connection in Settings &gt; Integrations first.
              </p>
            ) : (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    type="search"
                    value={query}
                    onChange={(e) =>
                      setSearchByConn((prev) => ({
                        ...prev,
                        [state.connectionId]: e.target.value,
                      }))
                    }
                    placeholder="Search tools by name or description…"
                    className="pl-8"
                    aria-label={`Search ${state.connectionName} tools`}
                  />
                </div>

                {groups.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tools match “{query}”.</p>
                ) : (
                  <div className="space-y-6">
                    {groups.map((group) => {
                      const groupToolNames = group.tools.map((t) => t.name);
                      const groupSelectedCount = groupToolNames.filter((n) =>
                        state.checkedTools.has(n)
                      ).length;
                      const groupChecked: boolean | "indeterminate" =
                        groupSelectedCount === 0
                          ? false
                          : groupSelectedCount === group.tools.length
                            ? true
                            : "indeterminate";
                      const groupAllId = `mcp-group-${state.connectionId}-${group.key}`;
                      return (
                        <div key={group.key} className="space-y-1">
                          {/* Group header doubles as a tri-state "select all in group". */}
                          <div className="flex items-center gap-2 px-2">
                            <Checkbox
                              id={groupAllId}
                              checked={groupChecked}
                              onCheckedChange={(v) =>
                                handleGroupToggle(state.connectionId, groupToolNames, v === true)
                              }
                              aria-label={`Select all ${group.label} tools`}
                            />
                            <Label
                              htmlFor={groupAllId}
                              className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-foreground"
                            >
                              {group.label}
                              <span className="font-normal text-muted-foreground tabular-nums">
                                {groupSelectedCount}/{group.tools.length}
                              </span>
                            </Label>
                          </div>
                          <div className="space-y-0.5">
                            {group.tools.map((tool) => {
                              const inputId = `mcp-tool-${state.connectionId}-${tool.name}`;
                              return (
                                <div
                                  key={tool.name}
                                  className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
                                >
                                  <Checkbox
                                    id={inputId}
                                    checked={state.checkedTools.has(tool.name)}
                                    onCheckedChange={() =>
                                      handleToolToggle(state.connectionId, tool.name)
                                    }
                                    aria-label={tool.name}
                                    className="mt-0.5 shrink-0"
                                  />
                                  {/* `block` overrides the shadcn Label's base
                                      `flex items-center` — otherwise name and
                                      description sit side-by-side. `min-w-0
                                      flex-1` lets it fill the row so the clamped
                                      description has a width to wrap against. */}
                                  <Label
                                    htmlFor={inputId}
                                    className="block min-w-0 flex-1 cursor-pointer"
                                  >
                                    <span className="block font-mono text-sm font-medium text-foreground">
                                      {tool.name}
                                    </span>
                                    {tool.description && (
                                      // No `block` here: line-clamp-2 needs its
                                      // own `display:-webkit-box`, which `block`
                                      // would override (silently killing the clamp).
                                      <span
                                        title={tool.description}
                                        className="mt-0.5 line-clamp-2 text-sm font-normal leading-snug text-muted-foreground"
                                      >
                                        {tool.description}
                                      </span>
                                    )}
                                  </Label>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}
    </>
  );
}
