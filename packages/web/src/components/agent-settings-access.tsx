"use client";

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EnterpriseFeatureCard } from "@/components/enterprise-feature-card";

interface AccessValues {
  visibility: string;
  groupIds: string[];
}

interface Group {
  id: string;
  name: string;
}

interface AgentSettingsAccessProps {
  agent: { visibility: string };
  currentGroupIds: string[];
  onChange: (values: AccessValues, isDirty: boolean) => void;
}

function sortedJson(arr: string[]) {
  return JSON.stringify([...arr].sort());
}

export function AgentSettingsAccess({
  agent,
  currentGroupIds,
  onChange,
}: AgentSettingsAccessProps) {
  const [visibility, setVisibility] = useState(agent.visibility || "restricted");
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>(currentGroupIds);
  const [groups, setGroups] = useState<Group[]>([]);
  const [isEnterprise, setIsEnterprise] = useState<boolean | null>(null);

  // Baseline tracks the last saved server state (updates when props change after save + refetch)
  const [baselineVisibility, setBaselineVisibility] = useState(agent.visibility || "restricted");
  const [baselineGroupIds, setBaselineGroupIds] = useState(currentGroupIds);

  // Sync baseline and editing state when parent provides new data (after save + refetch)
  const [prevPropsVisibility, setPrevPropsVisibility] = useState(agent.visibility);
  const [prevPropsGroupIds, setPrevPropsGroupIds] = useState(currentGroupIds);
  if (
    agent.visibility !== prevPropsVisibility ||
    sortedJson(currentGroupIds) !== sortedJson(prevPropsGroupIds)
  ) {
    setPrevPropsVisibility(agent.visibility);
    setPrevPropsGroupIds(currentGroupIds);
    setBaselineVisibility(agent.visibility || "restricted");
    setBaselineGroupIds(currentGroupIds);
    setVisibility(agent.visibility || "restricted");
    setSelectedGroupIds(currentGroupIds);
  }

  useEffect(() => {
    fetch("/api/enterprise/status")
      .then((res) => (res.ok ? res.json() : { enterprise: false }))
      .then((data) => setIsEnterprise(data.enterprise))
      .catch(() => setIsEnterprise(false));
  }, []);

  useEffect(() => {
    if (!isEnterprise) return;
    fetch("/api/groups")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setGroups(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [isEnterprise]);

  useEffect(() => {
    const isDirty =
      visibility !== baselineVisibility ||
      sortedJson(selectedGroupIds) !== sortedJson(baselineGroupIds);
    onChange({ visibility, groupIds: selectedGroupIds }, isDirty);
  }, [visibility, selectedGroupIds, baselineVisibility, baselineGroupIds, onChange]);

  function handleVisibilityChange(value: string) {
    setVisibility(value);
    if (value !== "restricted") {
      setSelectedGroupIds([]);
    }
  }

  function toggleGroup(groupId: string) {
    setSelectedGroupIds((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId]
    );
  }

  if (isEnterprise === null) {
    return <p>Loading...</p>;
  }

  if (!isEnterprise) {
    return (
      <EnterpriseFeatureCard
        feature="Access Control"
        description="Control which users and groups can access this agent. Set visibility to specific groups or make agents available to everyone."
      />
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Agent Visibility</h3>
        <p className="text-sm text-muted-foreground">
          Control which users can see and use this agent.
        </p>
        <div className="space-y-2">
          <Label htmlFor="visibility">Visibility</Label>
          <Select value={visibility} onValueChange={handleVisibilityChange}>
            <SelectTrigger id="visibility">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All users</SelectItem>
              <SelectItem value="restricted">Restricted</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      {visibility === "restricted" && (
        <section className="space-y-4">
          <h3 className="text-lg font-semibold">Allowed Groups</h3>
          <p className="text-sm text-muted-foreground">
            Select which groups can access this agent.
          </p>
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No groups available. Create groups in Settings first.
            </p>
          ) : (
            <div className="space-y-3">
              {groups.map((group) => (
                <div key={group.id} className="flex items-center space-x-3">
                  <Checkbox
                    id={`group-${group.id}`}
                    checked={selectedGroupIds.includes(group.id)}
                    onCheckedChange={() => toggleGroup(group.id)}
                    aria-label={group.name}
                  />
                  <Label htmlFor={`group-${group.id}`} className="cursor-pointer">
                    {group.name}
                  </Label>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
