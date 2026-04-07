"use client";

import { useState, useEffect, useCallback, useOptimistic, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InviteDialog } from "@/components/invite-dialog";
import { UserDetailSheet } from "@/components/user-detail-sheet";
import { StatusBadge } from "@/components/status-badge";
import { toast } from "sonner";
import { mergeUserList, type UserListItem, type UserGroup } from "@/lib/user-list";

interface SettingsUsersProps {
  currentUserId: string;
  refreshKey?: number;
}

function GroupBadges({ groups }: { groups: UserGroup[] }) {
  const MAX_VISIBLE = 2;
  const visible = groups.slice(0, MAX_VISIBLE);
  const remaining = groups.slice(MAX_VISIBLE);
  return (
    <div className="flex flex-wrap gap-1 overflow-hidden">
      {visible.map((g) => (
        <Badge
          key={g.id}
          variant="secondary"
          className="text-xs max-w-[150px] inline-block truncate"
          title={g.name}
        >
          {g.name}
        </Badge>
      ))}
      {remaining.length > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="text-xs">
                +{remaining.length} more
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{remaining.map((g) => g.name).join(", ")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

export function SettingsUsers({ currentUserId, refreshKey }: SettingsUsersProps) {
  const [items, setItems] = useState<UserListItem[]>([]);
  const [, startRevokeTransition] = useTransition();
  // useOptimistic lets the invite row disappear immediately when Revoke is
  // clicked, without waiting for the DELETE + refetch round-trip. The base
  // `items` state catches up once fetchUsers() lands.
  const [optimisticItems, applyOptimistic] = useOptimistic<
    UserListItem[],
    { type: "removeInvite"; id: string }
  >(items, (current, action) => {
    if (action.type === "removeInvite") {
      return current.filter((i) => !(i.kind === "invite" && i.id === action.id));
    }
    return current;
  });
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<(UserListItem & { kind: "user" }) | null>(null);
  const [allGroups, setAllGroups] = useState<{ id: string; name: string }[]>([]);
  const [isEnterprise, setIsEnterprise] = useState(false);

  const fetchUsers = useCallback(async () => {
    try {
      const [usersRes, invitesRes, groupsData, enterpriseData] = await Promise.all([
        fetch("/api/users"),
        fetch("/api/users/invites"),
        fetch("/api/groups")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
        fetch("/api/enterprise/status")
          .then((r) => (r.ok ? r.json() : { enterprise: false }))
          .catch(() => ({ enterprise: false })),
      ]);
      if (usersRes.ok) {
        const usersData = await usersRes.json();
        const invitesData = invitesRes.ok ? await invitesRes.json() : { invites: [] };
        setItems(mergeUserList(usersData.users, invitesData.invites));
      }
      setAllGroups(Array.isArray(groupsData) ? groupsData : []);
      setIsEnterprise(enterpriseData?.enterprise ?? false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers, refreshKey]);

  useEffect(() => {
    if (!selectedUser || !isEnterprise) return;
    fetch("/api/groups")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setAllGroups(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [selectedUser, isEnterprise]);

  function handleRevoke(inviteId: string) {
    startRevokeTransition(async () => {
      applyOptimistic({ type: "removeInvite", id: inviteId });
      await fetch(`/api/users/invites/${inviteId}`, { method: "DELETE" });
      fetchUsers();
    });
  }

  async function handleResend(item: UserListItem & { kind: "invite" }) {
    const deleteRes = await fetch(`/api/users/invites/${item.id}`, { method: "DELETE" });
    if (!deleteRes.ok) {
      fetchUsers();
      return;
    }
    const res = await fetch("/api/users/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: item.email || undefined, role: item.role }),
    });
    if (res.ok) {
      const data = await res.json();
      setResetLink(`${window.location.origin}/invite/${data.token}`);
    }
    fetchUsers();
  }

  if (loading) {
    return <p>Loading...</p>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Users</CardTitle>
          <Button onClick={() => setInviteOpen(true)}>Invite User</Button>
        </CardHeader>
        <CardContent>
          {resetLink && (
            <div className="mb-4 rounded border bg-muted p-3">
              <p className="text-sm font-medium mb-1">Invite link:</p>
              <p className="text-sm break-all">{resetLink}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  navigator.clipboard.writeText(resetLink);
                  toast("Link copied to clipboard");
                }}
              >
                Copy
              </Button>
            </div>
          )}

          {/* Mobile card view */}
          <div className="block lg:hidden space-y-3">
            {optimisticItems.map((item) => (
              <div
                key={`${item.kind}-${item.id}`}
                className={`rounded border p-3 space-y-2 ${item.status === "deactivated" ? "opacity-50" : ""} ${item.kind === "user" ? "cursor-pointer hover:bg-muted/50" : ""}`}
                onClick={() => item.kind === "user" && setSelectedUser(item)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="font-medium truncate max-w-[180px]"
                      title={item.kind === "user" ? item.name : undefined}
                    >
                      {item.kind === "user" ? item.name : "\u2014"}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {item.role}
                    </Badge>
                    <StatusBadge status={item.status} />
                    {isEnterprise && <GroupBadges groups={item.groups || []} />}
                  </div>
                </div>
                <div
                  className="text-sm text-muted-foreground truncate"
                  title={item.kind === "user" ? item.email : item.email || undefined}
                >
                  {item.kind === "user" ? item.email : item.email || "\u2014"}
                </div>
                <div className="flex gap-2">
                  {item.kind === "invite" && item.status === "pending" && (
                    <Button variant="outline" size="sm" onClick={() => handleRevoke(item.id)}>
                      Revoke
                    </Button>
                  )}
                  {item.kind === "invite" && item.status === "expired" && (
                    <Button variant="outline" size="sm" onClick={() => handleResend(item)}>
                      Resend
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden lg:block">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[18%]">Name</TableHead>
                  <TableHead className="w-[22%]">Email</TableHead>
                  <TableHead className="w-[10%]">Role</TableHead>
                  {isEnterprise && <TableHead className="w-[25%]">Groups</TableHead>}
                  <TableHead className="w-[10%]">Status</TableHead>
                  <TableHead className="w-[15%]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {optimisticItems.map((item) => (
                  <TableRow
                    key={`${item.kind}-${item.id}`}
                    className={`${item.status === "deactivated" ? "opacity-50" : ""} ${item.kind === "user" ? "cursor-pointer hover:bg-muted/50" : ""}`}
                    onClick={() => item.kind === "user" && setSelectedUser(item)}
                  >
                    <TableCell
                      className="truncate"
                      title={item.kind === "user" ? item.name : undefined}
                    >
                      {item.kind === "user" ? item.name : "\u2014"}
                    </TableCell>
                    <TableCell
                      className="truncate"
                      title={item.kind === "user" ? item.email : item.email || undefined}
                    >
                      {item.kind === "user" ? item.email : item.email || "\u2014"}
                    </TableCell>
                    <TableCell>{item.role}</TableCell>
                    {isEnterprise && (
                      <TableCell>
                        <GroupBadges groups={item.groups || []} />
                      </TableCell>
                    )}
                    <TableCell>
                      <StatusBadge status={item.status} />
                    </TableCell>
                    <TableCell className="space-x-2">
                      {item.kind === "invite" && item.status === "pending" && (
                        <Button variant="outline" size="sm" onClick={() => handleRevoke(item.id)}>
                          Revoke
                        </Button>
                      )}
                      {item.kind === "invite" && item.status === "expired" && (
                        <Button variant="outline" size="sm" onClick={() => handleResend(item)}>
                          Resend
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={(open) => {
          setInviteOpen(open);
          if (!open) fetchUsers();
        }}
      />

      {selectedUser && (
        <UserDetailSheet
          key={selectedUser.id}
          user={selectedUser}
          allGroups={allGroups}
          isEnterprise={isEnterprise}
          currentUserId={currentUserId}
          open={!!selectedUser}
          onOpenChange={(open) => !open && setSelectedUser(null)}
          onSaved={() => {
            setSelectedUser(null);
            fetchUsers();
          }}
        />
      )}
    </div>
  );
}
