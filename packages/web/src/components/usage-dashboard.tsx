"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { EnterpriseFeatureCard } from "@/components/enterprise-feature-card";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

interface AgentSummary {
  agentId: string;
  agentName: string;
  totalInputTokens: string | null;
  totalOutputTokens: string | null;
  totalCost: string | null;
}

interface SummaryResponse {
  agents: AgentSummary[];
}

interface TimeseriesPoint {
  date: string;
  inputTokens: string | null;
  outputTokens: string | null;
  cost: string | null;
}

interface UserSummary {
  userId: string;
  userName: string;
  totalInputTokens: string | null;
  totalOutputTokens: string | null;
  totalCost: string | null;
}

interface ByUserResponse {
  users: UserSummary[];
}

interface TimeseriesResponse {
  data: TimeseriesPoint[];
}

interface UsageDashboardProps {
  isEnterprise?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

type DaysOption = 7 | 30 | 90 | "all";

const PERIOD_OPTIONS: { label: string; value: DaysOption }[] = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "All", value: "all" },
];

export function UsageDashboard({ isEnterprise: initialEnterprise = false }: UsageDashboardProps) {
  const [enterprise, setEnterprise] = useState(initialEnterprise);
  const [days, setDays] = useState<DaysOption>(30);
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesResponse | null>(null);
  const [knownAgents, setKnownAgents] = useState<AgentSummary[]>([]);
  const [byUser, setByUser] = useState<ByUserResponse | null>(null);
  const [activeTab, setActiveTab] = useState("by-agent");

  // Fetch fresh enterprise status client-side (server value may be stale after dev toggle)
  useEffect(() => {
    fetch("/api/enterprise/status")
      .then((r) => r.json())
      .then((data) => setEnterprise(data.enterprise ?? false))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    params.set("days", days === "all" ? "0" : String(days));
    if (selectedAgent !== "all") params.set("agentId", selectedAgent);
    const qs = params.toString() ? `?${params.toString()}` : "";

    Promise.all([
      fetch(`/api/usage/summary${qs}`).then((r) => {
        if (!r.ok) throw new Error(`Summary API error: ${r.status}`);
        return r.json();
      }),
      fetch(`/api/usage/timeseries${qs}`).then((r) => {
        if (!r.ok) throw new Error(`Timeseries API error: ${r.status}`);
        return r.json();
      }),
    ])
      .then(([summaryData, timeseriesData]) => {
        if (!cancelled) {
          setSummary(summaryData);
          setTimeseries(timeseriesData);
          // Only update agent list when not filtering by agent (to keep full list)
          if (selectedAgent === "all" && summaryData.agents?.length > 0) {
            setKnownAgents(summaryData.agents);
          }
        }
      })
      .catch((err) => {
        console.error("[usage] Failed to fetch usage data:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [days, selectedAgent]);

  useEffect(() => {
    if (!enterprise || activeTab !== "by-user") return;
    let cancelled = false;
    const params = new URLSearchParams();
    params.set("days", days === "all" ? "0" : String(days));
    if (selectedAgent !== "all") params.set("agentId", selectedAgent);
    const qs = params.toString() ? `?${params.toString()}` : "";

    fetch(`/api/usage/by-user${qs}`)
      .then((r) => {
        if (!r.ok) throw new Error(`By-user API error: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) setByUser(data);
      })
      .catch((err) => {
        console.error("[usage] Failed to fetch by-user data:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [enterprise, activeTab, days, selectedAgent]);

  function handleDaysChange(value: DaysOption) {
    setSummary(null);
    setTimeseries(null);
    setByUser(null);
    setDays(value);
  }

  function handleAgentChange(value: string) {
    setSummary(null);
    setTimeseries(null);
    setByUser(null);
    setSelectedAgent(value);
  }

  function handleTabChange(value: string) {
    setActiveTab(value);
  }

  const loading = summary === null || timeseries === null;

  const totalTokens = (summary?.agents ?? []).reduce(
    (acc, a) => acc + Number(a.totalInputTokens ?? 0) + Number(a.totalOutputTokens ?? 0),
    0
  );
  const totalCost = (summary?.agents ?? []).reduce((acc, a) => acc + Number(a.totalCost ?? 0), 0);

  const chartData = (timeseries?.data ?? []).map((p) => ({
    date: p.date,
    inputTokens: Number(p.inputTokens ?? 0),
    outputTokens: Number(p.outputTokens ?? 0),
  }));

  const hasData = (summary?.agents?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-bold">Usage & Costs</h2>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <select
            aria-label="Select time period"
            value={String(days)}
            onChange={(e) => {
              const v = e.target.value;
              handleDaysChange(v === "all" ? "all" : (Number(v) as 7 | 30 | 90));
            }}
            className="border-input bg-transparent text-sm rounded-md border px-3 py-1.5 h-8 sm:hidden"
          >
            {PERIOD_OPTIONS.map((opt) => (
              <option key={opt.label} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="hidden sm:flex gap-1">
            {PERIOD_OPTIONS.map((opt) => (
              <Button
                key={opt.label}
                variant={days === opt.value ? "default" : "outline"}
                size="sm"
                onClick={() => handleDaysChange(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          {knownAgents.length > 0 && (
            <select
              aria-label="Filter by agent"
              value={selectedAgent}
              onChange={(e) => handleAgentChange(e.target.value)}
              className="border-input bg-transparent text-sm rounded-md border px-3 py-1.5 h-8"
            >
              <option value="all">All Agents</option>
              {knownAgents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.agentName}
                </option>
              ))}
            </select>
          )}
          {hasData && (
            <TooltipProvider>
              <UiTooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={!enterprise ? 0 : undefined}>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!enterprise}
                      onClick={() => {
                        if (!enterprise) return;
                        const params = new URLSearchParams();
                        params.set("format", "csv");
                        params.set("days", days === "all" ? "0" : String(days));
                        if (selectedAgent !== "all") params.set("agentId", selectedAgent);
                        window.open(`/api/usage/export?${params.toString()}`);
                      }}
                    >
                      Export CSV
                    </Button>
                  </span>
                </TooltipTrigger>
                {!enterprise && (
                  <TooltipContent>
                    <p>Enterprise feature</p>
                  </TooltipContent>
                )}
              </UiTooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : !hasData ? (
        <p>No usage data available.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Tokens
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatTokens(totalTokens)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Estimated Cost
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatCost(totalCost)}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Daily Token Usage</CardTitle>
            </CardHeader>
            <CardContent className="px-2 sm:px-6">
              <ResponsiveContainer width="100%" height={250} className="sm:!h-[300px]">
                <LineChart data={chartData} margin={{ left: -10, right: 5, top: 5, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.9 0 0)" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(d) => {
                      const date = new Date(d);
                      return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                    }}
                    interval="preserveStartEnd"
                    tick={{ fontSize: 11 }}
                    tickMargin={4}
                  />
                  <YAxis tickFormatter={formatTokens} tick={{ fontSize: 11 }} width={45} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const date = new Date(label as string);
                      return (
                        <div className="rounded-md border bg-background p-2 shadow-sm text-sm">
                          <p className="font-medium mb-1">
                            {date.toLocaleDateString("en-US", {
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                            })}
                          </p>
                          {payload.map((entry) => (
                            <p key={entry.name} style={{ color: entry.color }}>
                              {entry.name}: {formatTokens(Number(entry.value ?? 0))}
                            </p>
                          ))}
                        </div>
                      );
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="inputTokens"
                    stroke="oklch(0.65 0.195 50)"
                    strokeWidth={2}
                    dot={false}
                    name="Input Tokens"
                  />
                  <Line
                    type="monotone"
                    dataKey="outputTokens"
                    stroke="oklch(0.62 0.1 230)"
                    strokeWidth={2}
                    dot={false}
                    name="Output Tokens"
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList>
              <TabsTrigger value="by-agent">By Agent</TabsTrigger>
              <TabsTrigger value="by-user">By User</TabsTrigger>
            </TabsList>
            <TabsContent value="by-agent" forceMount className="data-[state=inactive]:hidden">
              <Card>
                <CardHeader>
                  <CardTitle>Per-Agent Breakdown</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Agent</TableHead>
                        <TableHead className="text-right">Input Tokens</TableHead>
                        <TableHead className="text-right">Output Tokens</TableHead>
                        <TableHead className="text-right">Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...summary!.agents]
                        .sort((a, b) => {
                          const costDiff = Number(b.totalCost ?? 0) - Number(a.totalCost ?? 0);
                          if (costDiff !== 0) return costDiff;
                          return (
                            Number(b.totalInputTokens ?? 0) +
                            Number(b.totalOutputTokens ?? 0) -
                            Number(a.totalInputTokens ?? 0) -
                            Number(a.totalOutputTokens ?? 0)
                          );
                        })
                        .map((agent) => (
                          <TableRow key={agent.agentId}>
                            <TableCell>{agent.agentName}</TableCell>
                            <TableCell className="text-right">
                              {formatTokens(Number(agent.totalInputTokens ?? 0))}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatTokens(Number(agent.totalOutputTokens ?? 0))}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCost(Number(agent.totalCost ?? 0))}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="by-user" forceMount className="data-[state=inactive]:hidden">
              {enterprise ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Per-User Breakdown</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {byUser === null ? (
                      <p>Loading...</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>User</TableHead>
                            <TableHead className="text-right">Input Tokens</TableHead>
                            <TableHead className="text-right">Output Tokens</TableHead>
                            <TableHead className="text-right">Cost</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[...byUser.users]
                            .sort((a, b) => {
                              const costDiff = Number(b.totalCost ?? 0) - Number(a.totalCost ?? 0);
                              if (costDiff !== 0) return costDiff;
                              return (
                                Number(b.totalInputTokens ?? 0) +
                                Number(b.totalOutputTokens ?? 0) -
                                Number(a.totalInputTokens ?? 0) -
                                Number(a.totalOutputTokens ?? 0)
                              );
                            })
                            .map((user) => (
                              <TableRow key={user.userId}>
                                <TableCell>{user.userName}</TableCell>
                                <TableCell className="text-right">
                                  {formatTokens(Number(user.totalInputTokens ?? 0))}
                                </TableCell>
                                <TableCell className="text-right">
                                  {formatTokens(Number(user.totalOutputTokens ?? 0))}
                                </TableCell>
                                <TableCell className="text-right">
                                  {formatCost(Number(user.totalCost ?? 0))}
                                </TableCell>
                              </TableRow>
                            ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <EnterpriseFeatureCard
                  feature="Per-User Breakdown"
                  description="See which team members use the most tokens and which agents they prefer. Identify power users and optimize costs per person."
                />
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
