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

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  deletedAt: string | null;
}

interface SettingsUsersProps {
  currentUserId: string;
}

export function SettingsUsers({ currentUserId }: SettingsUsersProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [deactivateUserId, setDeactivateUserId] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/users");
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
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
              <p className="text-sm font-medium mb-1">Reset link:</p>
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
            {users.map((user) => (
              <div
                key={user.id}
                className={`rounded border p-3 space-y-2 ${user.deletedAt ? "opacity-50" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{user.name}</span>
                    <Badge variant="outline" className="text-xs">
                      {user.role}
                    </Badge>
                    {user.deletedAt && (
                      <Badge variant="outline" className="text-xs">
                        deactivated
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="text-sm text-muted-foreground">{user.email}</div>
                {user.id !== currentUserId && (
                  <div className="flex gap-2">
                    {!user.deletedAt ? (
                      <>
                        <Button variant="outline" size="sm" onClick={() => handleReset(user.id)}>
                          Reset
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setDeactivateUserId(user.id)}
                        >
                          Deactivate
                        </Button>
                      </>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => handleReactivate(user.id)}>
                        Reactivate
                      </Button>
                    )}
                  </div>
                )}
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
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id} className={user.deletedAt ? "opacity-50" : ""}>
                    <TableCell>
                      {user.name}
                      {user.deletedAt && (
                        <Badge variant="outline" className="ml-2 text-xs">
                          deactivated
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>{user.role}</TableCell>
                    <TableCell className="space-x-2">
                      {user.id !== currentUserId && (
                        <>
                          {!user.deletedAt ? (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleReset(user.id)}
                              >
                                Reset
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => setDeactivateUserId(user.id)}
                              >
                                Deactivate
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleReactivate(user.id)}
                            >
                              Reactivate
                            </Button>
                          )}
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />

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
