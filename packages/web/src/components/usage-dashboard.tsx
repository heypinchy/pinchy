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
  totals: {
    totalInputTokens: string | null;
    totalOutputTokens: string | null;
    totalCost: string | null;
  };
}

interface TimeseriesPoint {
  date: string;
  inputTokens: string | null;
  outputTokens: string | null;
  cost: string | null;
}

interface TimeseriesResponse {
  points: TimeseriesPoint[];
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

export function UsageDashboard() {
  const [days, setDays] = useState<DaysOption>(30);
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesResponse | null>(null);
  const [knownAgents, setKnownAgents] = useState<AgentSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (days !== "all") params.set("days", String(days));
    if (selectedAgent !== "all") params.set("agentId", selectedAgent);
    const qs = params.toString() ? `?${params.toString()}` : "";

    Promise.all([
      fetch(`/api/usage/summary${qs}`).then((r) => r.json()),
      fetch(`/api/usage/timeseries${qs}`).then((r) => r.json()),
    ]).then(([summaryData, timeseriesData]) => {
      if (!cancelled) {
        setSummary(summaryData);
        setTimeseries(timeseriesData);
        // Only update agent list when not filtering by agent (to keep full list)
        if (selectedAgent === "all" && summaryData.agents?.length > 0) {
          setKnownAgents(summaryData.agents);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [days, selectedAgent]);

  function handleDaysChange(value: DaysOption) {
    setSummary(null);
    setTimeseries(null);
    setDays(value);
  }

  function handleAgentChange(value: string) {
    setSummary(null);
    setTimeseries(null);
    setSelectedAgent(value);
  }

  const loading = summary === null || timeseries === null;

  const totalTokens =
    Number(summary?.totals.totalInputTokens ?? 0) + Number(summary?.totals.totalOutputTokens ?? 0);
  const totalCost = Number(summary?.totals.totalCost ?? 0);

  const chartData = (timeseries?.points ?? []).map((p) => ({
    date: p.date,
    inputTokens: Number(p.inputTokens ?? 0),
    outputTokens: Number(p.outputTokens ?? 0),
  }));

  const hasData = (summary?.agents?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Usage & Costs</h2>
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
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
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="inputTokens"
                    stroke="#3b82f6"
                    name="Input Tokens"
                  />
                  <Line
                    type="monotone"
                    dataKey="outputTokens"
                    stroke="#f97316"
                    name="Output Tokens"
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

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
                  {summary!.agents.map((agent) => (
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
        </>
      )}
    </div>
  );
}
