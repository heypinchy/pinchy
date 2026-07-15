"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { apiGet, ApiError } from "@/lib/api-client";
import {
  groupMcpTools,
  filterMcpTools,
  type McpToolInfo,
} from "@/lib/integrations/mcp-tool-groups";
import type { McpIntegrationData } from "@/lib/integrations/types";
import type { SetAgentIntegrationsInput } from "@/lib/schemas/agent-integrations";

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * Local, narrower connection shape — mirrors `use-odoo-permissions.ts`'s
 * `Connection` (a component-local view onto the wider `Connection` type in
 * `agent-settings-permissions.tsx`/`agent-settings-page-content.tsx`, which
 * declares `data?: unknown` because it's shared across integration types).
 */
export interface McpPermissionConnection {
  id: string;
  name: string;
  type: string;
  status?: string;
  data?: unknown;
}

/** One connection's granted tools, in the shape the PUT route expects. */
export type McpIntegrationValue = SetAgentIntegrationsInput;

interface McpPermissionSectionProps {
  agentId: string;
  connections: McpPermissionConnection[];
  onChange: (values: McpIntegrationValue[], isDirty: boolean) => void;
}

/** Shape of one entry in the GET /api/agents/[agentId]/integrations response. */
interface AgentIntegrationEntry {
  connectionId: string;
  connectionType: string;
  permissions: Array<{ model: string; operation: string }>;
}

interface ConnectionState {
  connectionId: string;
  connectionName: string;
  availableTools: McpToolInfo[];
  checkedTools: Set<string>;
  initialTools: Set<string>;
}

// ── Component ────────────────────────────────────────────────────────────

export function McpPermissionSection({
  agentId,
  connections,
  onChange,
}: McpPermissionSectionProps) {
  // Keyed by connectionId. Seeded once from the GET response (see the load
  // effect below) and never reset afterwards — see that effect's comment for
  // why it deliberately does not depend on `connections`.
  const [initialByConnection, setInitialByConnection] = useState<Map<string, Set<string>>>(
    new Map()
  );
  const [checkedByConnection, setCheckedByConnection] = useState<Map<string, Set<string>>>(
    new Map()
  );
  // Lazy-initialized from the mount-time `connections` snapshot: when there's
  // nothing to load (no MCP connections at all) we start already "not
  // loading" instead of flipping the state synchronously inside the effect
  // below (react-hooks/set-state-in-effect forbids a direct setState call in
  // an effect's synchronous body).
  const [loading, setLoading] = useState(() => connections.length > 0);
  // Per-connection search query (connectionId → query).
  const [searchByConn, setSearchByConn] = useState<Record<string, string>>({});

  // Stable ref for onChange to avoid stale-closure/infinite-loop issues.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Load this agent's currently granted MCP tools once per agentId.
  //
  // Deliberately depends on [agentId] only, NOT [agentId, connections]. The
  // Odoo/Email sections re-run their load effect whenever `connections`
  // changes reference (see agent-settings-permissions.tsx's comment on the
  // post-save re-sync cascade) — for a single-connection dropdown that just
  // means "re-pick the same connection". For MCP's N-connections-at-once
  // layout, re-running on every `connections` reference change would instead
  // WIPE any in-progress checkbox edits back to the last-saved state (the
  // parent's `connections` prop reference changes on every fetchData() call,
  // including the one that fires right after an unrelated tab's save). Since
  // available tools are read live from the `connections` prop on every
  // render (see `connectionStates` below), the only thing this effect owns
  // is the one-time "what's currently granted" snapshot.
  useEffect(() => {
    // Nothing to load — `loading` was already lazy-initialized to false for
    // this case (see the useState above), so there's no state to flip here.
    if (connections.length === 0) return;

    let cancelled = false;

    async function load() {
      try {
        const data = await apiGet<AgentIntegrationEntry[]>(`/api/agents/${agentId}/integrations`);
        if (cancelled) return;

        const initial = new Map<string, Set<string>>();
        for (const entry of data) {
          if (entry.connectionType !== "mcp") continue;
          const tools = new Set(
            entry.permissions.filter((p) => p.model === "mcp").map((p) => p.operation)
          );
          if (tools.size > 0) initial.set(entry.connectionId, tools);
        }
        setInitialByConnection(initial);
        // Deep-copy so toggling `checked` never mutates `initial`'s Sets.
        setCheckedByConnection(new Map(Array.from(initial, ([id, tools]) => [id, new Set(tools)])));
      } catch (err) {
        if (!cancelled) {
          toast.error(
            err instanceof ApiError ? err.message : "Couldn't load MCP tool permissions."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Derived per-connection view: available tools come live from the
  // `connections` prop; checked/initial tools are intersected against the
  // CURRENT tool list so a tool that drifted out of `data.tools` since it was
  // granted (server removed/renamed it on a later sync) never renders as
  // checked and never gets re-submitted — mirrors build.ts's own
  // grants ∩ data.tools intersection (T6), so the UI can't show a grant that
  // the runtime config would silently drop anyway.
  const connectionStates = useMemo<ConnectionState[]>(() => {
    return connections.map((conn) => {
      const data = (conn.data ?? null) as McpIntegrationData | null;
      const availableTools: McpToolInfo[] = (data?.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
      }));
      const availableNames = new Set(availableTools.map((t) => t.name));
      const rawInitial = initialByConnection.get(conn.id) ?? new Set<string>();
      const rawChecked = checkedByConnection.get(conn.id) ?? rawInitial;

      return {
        connectionId: conn.id,
        connectionName: conn.name,
        availableTools,
        checkedTools: new Set([...rawChecked].filter((t) => availableNames.has(t))),
        initialTools: new Set([...rawInitial].filter((t) => availableNames.has(t))),
      };
    });
  }, [connections, initialByConnection, checkedByConnection]);

  // Notify the parent whenever the derived state changes. A connection is
  // only included in the payload when it's actually "relevant" to this agent
  // (currently or previously granted something) — an untouched connection
  // with zero grants must NOT produce a PUT on save (see
  // agent-settings-permissions.tsx for how these entries get merged into the
  // combined `integrations` array). A connection that had grants and now has
  // none is still included WITH AN EMPTY permissions array: PUT replaces all
  // permissions for exactly the given connectionId (T5), so this is the only
  // way to actually clear a revoked-to-zero connection without wiping every
  // OTHER connection's grants (unlike Odoo/Email's single-connection
  // dropdown, MCP supports several connections at once).
  useEffect(() => {
    if (loading) return;

    const values: McpIntegrationValue[] = [];
    let anyDirty = false;

    for (const state of connectionStates) {
      const relevant = state.initialTools.size > 0 || state.checkedTools.size > 0;
      if (!relevant) continue;

      values.push({
        connectionId: state.connectionId,
        permissions: Array.from(state.checkedTools)
          .sort()
          .map((operation) => ({ model: "mcp", operation })),
      });

      const dirty =
        state.checkedTools.size !== state.initialTools.size ||
        Array.from(state.checkedTools).some((t) => !state.initialTools.has(t));
      if (dirty) anyDirty = true;
    }

    onChangeRef.current(values, anyDirty);
  }, [connectionStates, loading]);

  const toggleTool = useCallback((connectionId: string, toolName: string) => {
    setCheckedByConnection((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(connectionId) ?? []);
      if (current.has(toolName)) current.delete(toolName);
      else current.add(toolName);
      next.set(connectionId, current);
      return next;
    });
  }, []);

  // Select/deselect all tools in a group at once. Callers pass the currently
  // VISIBLE (filtered) tool names, so "select all" with an active search only
  // touches what's on screen.
  const toggleGroup = useCallback((connectionId: string, toolNames: string[], checked: boolean) => {
    setCheckedByConnection((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(connectionId) ?? []);
      for (const name of toolNames) {
        if (checked) current.add(name);
        else current.delete(name);
      }
      next.set(connectionId, current);
      return next;
    });
  }, []);

  if (connections.length === 0) return null;

  if (loading) {
    return <div className="text-muted-foreground py-4">Loading MCP configuration...</div>;
  }

  return (
    <div className="space-y-8">
      {connectionStates.map((state) => {
        const query = searchByConn[state.connectionId] ?? "";
        const filtered = filterMcpTools(state.availableTools, query);
        const groups = groupMcpTools(filtered);
        const selectedCount = state.checkedTools.size;
        const totalCount = state.availableTools.length;

        return (
          <div key={state.connectionId} className="space-y-4">
            <div className="flex items-baseline justify-between gap-2">
              <h4 className="text-sm font-medium">{state.connectionName}</h4>
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
                                toggleGroup(state.connectionId, groupToolNames, v === true)
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
                                      toggleTool(state.connectionId, tool.name)
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
                                      // Tool descriptions are third-party text —
                                      // rendered as plain text (no
                                      // dangerouslySetInnerHTML) and clamped so a
                                      // hostile/misbehaving server can't blow out
                                      // the layout with an unbounded string.
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
          </div>
        );
      })}
    </div>
  );
}
