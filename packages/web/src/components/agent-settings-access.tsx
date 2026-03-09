"use client";

import { useState, useRef, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

export function AgentSettingsAccess({
  agent,
  currentGroupIds,
  onChange,
}: AgentSettingsAccessProps) {
  const [visibility, setVisibility] = useState(agent.visibility || "admin_only");
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>(currentGroupIds);
  const [groups, setGroups] = useState<Group[]>([]);

  const initialVisibility = useRef(agent.visibility || "admin_only");
  const initialGroupIds = useRef(currentGroupIds);

  useEffect(() => {
    fetch("/api/groups")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setGroups(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const isDirty =
      visibility !== initialVisibility.current ||
      JSON.stringify([...selectedGroupIds].sort()) !==
        JSON.stringify([...initialGroupIds.current].sort());
    onChange({ visibility, groupIds: selectedGroupIds }, isDirty);
  }, [visibility, selectedGroupIds, onChange]);

  function handleVisibilityChange(value: string) {
    setVisibility(value);
    if (value !== "groups") {
      setSelectedGroupIds([]);
    }
  }

  function toggleGroup(groupId: string) {
    setSelectedGroupIds((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId]
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
              <SelectItem value="admin_only">Admins only</SelectItem>
              <SelectItem value="all">All users</SelectItem>
              <SelectItem value="groups">Specific groups</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      {visibility === "groups" && (
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
