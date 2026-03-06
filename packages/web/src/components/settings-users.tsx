"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InviteDialog } from "@/components/invite-dialog";
import { mergeUserList, type UserListItem } from "@/lib/user-list";

interface SettingsUsersProps {
  currentUserId: string;
}

function StatusBadge({ status }: { status: UserListItem["status"] }) {
  const variants: Record<string, string> = {
    active: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    expired: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    deactivated: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
  };
  return (
    <Badge variant="outline" className={`text-xs ${variants[status]}`}>
      {status}
    </Badge>
  );
}

export function SettingsUsers({ currentUserId }: SettingsUsersProps) {
  const [items, setItems] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [deactivateUserId, setDeactivateUserId] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      const [usersRes, invitesRes] = await Promise.all([
        fetch("/api/users"),
        fetch("/api/users/invites"),
      ]);
      if (usersRes.ok) {
        const usersData = await usersRes.json();
        const invitesData = invitesRes.ok ? await invitesRes.json() : { invites: [] };
        setItems(mergeUserList(usersData.users, invitesData.invites));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  async function handleDeactivate(userId: string) {
    await fetch(`/api/users/${userId}`, { method: "DELETE" });
    setDeactivateUserId(null);
    fetchUsers();
  }

  async function handleReactivate(userId: string) {
    await fetch(`/api/users/${userId}/reactivate`, { method: "POST" });
    fetchUsers();
  }

  async function handleReset(userId: string) {
    const res = await fetch(`/api/users/${userId}/reset`, { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      setResetLink(`${window.location.origin}/invite/${data.token}`);
    }
  }

  async function handleRevoke(inviteId: string) {
    await fetch(`/api/users/invites/${inviteId}`, { method: "DELETE" });
    fetchUsers();
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
                }}
              >
                Copy
              </Button>
            </div>
          )}

          {/* Mobile card view */}
          <div className="block lg:hidden space-y-3">
            {items.map((item) => (
              <div
                key={`${item.kind}-${item.id}`}
                className={`rounded border p-3 space-y-2 ${item.status === "deactivated" ? "opacity-50" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
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
                  </div>
                </div>
                <div
                  className="text-sm text-muted-foreground truncate"
                  title={item.kind === "user" ? item.email : item.email || undefined}
                >
                  {item.kind === "user" ? item.email : item.email || "\u2014"}
                </div>
                <div className="flex gap-2">
                  {item.kind === "user" &&
                    item.status === "active" &&
                    item.id !== currentUserId && (
                      <>
                        <Button variant="outline" size="sm" onClick={() => handleReset(item.id)}>
                          Reset Password
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setDeactivateUserId(item.id)}
                        >
                          Deactivate
                        </Button>
                      </>
                    )}
                  {item.kind === "user" && item.status === "deactivated" && (
                    <Button variant="outline" size="sm" onClick={() => handleReactivate(item.id)}>
                      Reactivate
                    </Button>
                  )}
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow
                    key={`${item.kind}-${item.id}`}
                    className={item.status === "deactivated" ? "opacity-50" : ""}
                  >
                    <TableCell
                      className="max-w-[150px] truncate"
                      title={item.kind === "user" ? item.name : undefined}
                    >
                      {item.kind === "user" ? item.name : "\u2014"}
                    </TableCell>
                    <TableCell
                      className="max-w-[200px] truncate"
                      title={item.kind === "user" ? item.email : item.email || undefined}
                    >
                      {item.kind === "user" ? item.email : item.email || "\u2014"}
                    </TableCell>
                    <TableCell>{item.role}</TableCell>
                    <TableCell>
                      <StatusBadge status={item.status} />
                    </TableCell>
                    <TableCell className="space-x-2">
                      {item.kind === "user" &&
                        item.status === "active" &&
                        item.id !== currentUserId && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleReset(item.id)}
                            >
                              Reset Password
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => setDeactivateUserId(item.id)}
                            >
                              Deactivate
                            </Button>
                          </>
                        )}
                      {item.kind === "user" && item.status === "deactivated" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleReactivate(item.id)}
                        >
                          Reactivate
                        </Button>
                      )}
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

      <AlertDialog
        open={!!deactivateUserId}
        onOpenChange={(open) => !open && setDeactivateUserId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate User</AlertDialogTitle>
            <AlertDialogDescription>
              This user will no longer be able to log in. You can reactivate them later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deactivateUserId && handleDeactivate(deactivateUserId)}
            >
              Confirm Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
