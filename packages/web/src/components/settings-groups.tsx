"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EnterpriseFeatureCard } from "@/components/enterprise-feature-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

interface Group {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
}

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
}

interface GroupMember {
  userId: string;
  groupId: string;
}

interface SettingsGroupsProps {
  refreshKey?: number;
}

export function SettingsGroups({ refreshKey }: SettingsGroupsProps) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<Group | null>(null);
  const [deleteGroupId, setDeleteGroupId] = useState<string | null>(null);
  const [isEnterprise, setIsEnterprise] = useState<boolean | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formMemberIds, setFormMemberIds] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/enterprise/status")
      .then((res) => (res.ok ? res.json() : { enterprise: false }))
      .then((data) => setIsEnterprise(data.enterprise))
      .catch(() => setIsEnterprise(false));
  }, [refreshKey]);

  const fetchData = useCallback(async () => {
    try {
      const [groupsRes, usersRes] = await Promise.all([fetch("/api/groups"), fetch("/api/users")]);
      if (groupsRes.ok) {
        setGroups(await groupsRes.json());
      }
      if (usersRes.ok) {
        const data = await usersRes.json();
        setUsers(data.users);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isEnterprise) {
      fetchData();
    } else if (isEnterprise === false) {
      setLoading(false);
    }
  }, [isEnterprise, fetchData]);

  function openCreateDialog() {
    setFormName("");
    setFormDescription("");
    setFormMemberIds([]);
    setCreateOpen(true);
  }

  async function openEditDialog(group: Group) {
    setFormName(group.name);
    setFormDescription(group.description || "");
    // Fetch current members for this group
    try {
      const res = await fetch(`/api/groups/${group.id}/members`);
      if (res.ok) {
        const members: GroupMember[] = await res.json();
        setFormMemberIds(members.map((m) => m.userId));
      } else {
        setFormMemberIds([]);
      }
    } catch {
      setFormMemberIds([]);
    }
    setEditGroup(group);
  }

  async function handleCreate() {
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: formName, description: formDescription || null }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Failed to create group");
      return;
    }
    const newGroup = await res.json();
    if (formMemberIds.length > 0) {
      const memRes = await fetch(`/api/groups/${newGroup.id}/members`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: formMemberIds }),
      });
      if (!memRes.ok) {
        const err = await memRes.json().catch(() => ({}));
        toast.error(err.error || "Group created but failed to set members");
      }
    }
    setCreateOpen(false);
    fetchData();
  }

  async function handleEdit() {
    if (!editGroup) return;
    const res = await fetch(`/api/groups/${editGroup.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: formName, description: formDescription || null }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Failed to update group");
      return;
    }
    const memRes = await fetch(`/api/groups/${editGroup.id}/members`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds: formMemberIds }),
    });
    if (!memRes.ok) {
      const err = await memRes.json().catch(() => ({}));
      toast.error(err.error || "Failed to update group members");
    }
    setEditGroup(null);
    fetchData();
  }

  async function handleDelete(groupId: string) {
    const res = await fetch(`/api/groups/${groupId}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Failed to delete group");
      return;
    }
    setDeleteGroupId(null);
    fetchData();
  }

  function toggleMember(userId: string) {
    setFormMemberIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  }

  if (loading || isEnterprise === null) {
    return <p>Loading...</p>;
  }

  if (!isEnterprise) {
    return (
      <EnterpriseFeatureCard
        feature="Groups"
        description="Create groups to control which users can access which agents. Organize your team into departments like Engineering, Marketing, or HR, and assign agent access per group."
      />
    );
  }

  const activeUsers = users.filter((u) => !u.banned);

  const formDialog = (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="group-name">Name</Label>
        <Input
          id="group-name"
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          placeholder="e.g. Engineering"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="group-description">Description</Label>
        <Input
          id="group-description"
          value={formDescription}
          onChange={(e) => setFormDescription(e.target.value)}
          placeholder="Optional description"
        />
      </div>
      <div className="space-y-2">
        <Label>Members</Label>
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {activeUsers.map((user) => (
            <div key={user.id} className="flex items-center space-x-2">
              <Checkbox
                id={`member-${user.id}`}
                checked={formMemberIds.includes(user.id)}
                onCheckedChange={() => toggleMember(user.id)}
                aria-label={user.name}
              />
              <Label htmlFor={`member-${user.id}`} className="cursor-pointer text-sm">
                {user.name} ({user.email})
              </Label>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Groups</CardTitle>
          <Button onClick={openCreateDialog}>New Group</Button>
        </CardHeader>
        <CardContent>
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No groups yet. Create one to get started.
            </p>
          ) : (
            <>
              {/* Mobile card view */}
              <div className="block lg:hidden space-y-3">
                {groups.map((group) => (
                  <div key={group.id} className="rounded border p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{group.name}</span>
                      <Badge variant="secondary" className="text-xs">
                        {group.memberCount} {group.memberCount === 1 ? "member" : "members"}
                      </Badge>
                    </div>
                    {group.description && (
                      <p className="text-sm text-muted-foreground">{group.description}</p>
                    )}
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEditDialog(group)}>
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setDeleteGroupId(group.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <div className="hidden lg:block">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[25%]">Name</TableHead>
                      <TableHead className="w-[40%]">Description</TableHead>
                      <TableHead className="w-[10%]">Members</TableHead>
                      <TableHead className="w-[25%]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.map((group) => (
                      <TableRow key={group.id}>
                        <TableCell className="font-medium truncate" title={group.name}>
                          {group.name}
                        </TableCell>
                        <TableCell
                          className="text-muted-foreground truncate"
                          title={group.description || undefined}
                        >
                          {group.description || "\u2014"}
                        </TableCell>
                        <TableCell>{group.memberCount}</TableCell>
                        <TableCell className="space-x-2">
                          <Button variant="outline" size="sm" onClick={() => openEditDialog(group)}>
                            Edit
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setDeleteGroupId(group.id)}
                          >
                            Delete
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Group</DialogTitle>
            <DialogDescription>Create a new group to manage agent access.</DialogDescription>
          </DialogHeader>
          {formDialog}
          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={!formName.trim()}>
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editGroup} onOpenChange={(open) => !open && setEditGroup(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Group</DialogTitle>
            <DialogDescription>Update the group details and manage members.</DialogDescription>
          </DialogHeader>
          {formDialog}
          <div className="flex justify-end">
            <Button onClick={handleEdit} disabled={!formName.trim()}>
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteGroupId} onOpenChange={(open) => !open && setDeleteGroupId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Group</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the group and remove all member associations. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleteGroupId && handleDelete(deleteGroupId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
