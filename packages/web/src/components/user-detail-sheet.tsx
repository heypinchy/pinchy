"use client";

import { useState, useMemo } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/status-badge";
import { toast } from "sonner";
import type { UserListItem, UserGroup } from "@/lib/user-list";
import type { UserRole } from "@/db/enums";
import { apiPost, apiPut, apiPatch, apiDelete, ApiError, errorMessage } from "@/lib/api-client";
import type { UpdateUserInput, UpdateUserGroupsInput } from "@/lib/schemas/users";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { buildInviteUrl } from "@/lib/invite-url";

interface UserDetailSheetProps {
  user: UserListItem & { kind: "user" };
  allGroups: UserGroup[];
  isEnterprise: boolean;
  currentUserId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Full success: refetch the list AND close the sheet (parent unmounts it). */
  onSaved: () => void;
  /**
   * Partial success: refetch the list but KEEP the sheet open so the user can
   * retry the failed half. Distinct from `onSaved`, which closes the sheet —
   * calling `onSaved` here would unmount the sheet and lose the retry path.
   */
  onRefresh?: () => void;
}

export function UserDetailSheet({
  user,
  allGroups,
  isEnterprise,
  currentUserId,
  open,
  onOpenChange,
  onSaved,
  onRefresh,
}: UserDetailSheetProps) {
  const [selectedRole, setSelectedRole] = useState(user.role);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(
    () => new Set(user.groups.map((g) => g.id))
  );
  const [saving, setSaving] = useState(false);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const { isCopied: isResetLinkCopied, copy: copyResetLink } = useCopyToClipboard();

  const isOwnAccount = user.id === currentUserId;
  const isDeactivated = user.status === "deactivated";

  // Without an active license, group management is locked EXCEPT removing
  // existing memberships (restriction-tightening carve-out, § 5). Members
  // originally in a group can be unchecked (and re-checked before saving);
  // new memberships need a license.
  const originalGroupIds = new Set(user.groups.map((g) => g.id));
  const showGroups = allGroups.length > 0 && (isEnterprise || originalGroupIds.size > 0);
  const canAddToGroup = (groupId: string) => isEnterprise || originalGroupIds.has(groupId);

  const isDirty = useMemo(() => {
    if (selectedRole !== user.role) return true;

    const originalIds = new Set(user.groups.map((g) => g.id));
    if (selectedGroupIds.size !== originalIds.size) return true;
    for (const id of selectedGroupIds) {
      if (!originalIds.has(id)) return true;
    }
    return false;
  }, [selectedRole, selectedGroupIds, user.role, user.groups]);

  function handleGroupToggle(groupId: string) {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const roleChanged = selectedRole !== user.role;
      const originalIds = new Set(user.groups.map((g) => g.id));
      const groupsChanged =
        selectedGroupIds.size !== originalIds.size ||
        [...selectedGroupIds].some((id) => !originalIds.has(id));

      // The role PATCH and groups PUT are independent writes, so one can land
      // while the other fails. Track them separately instead of gating on
      // results.every(ok), which reports a total failure on a partial success
      // and leaves the table out of sync with what actually persisted.
      const rolePromise = roleChanged
        ? apiPatch<unknown, UpdateUserInput>(`/api/users/${user.id}`, { role: selectedRole })
        : null;

      const groupsPromise = groupsChanged
        ? apiPut<unknown, UpdateUserGroupsInput>(`/api/users/${user.id}/groups`, {
            groupIds: [...selectedGroupIds],
          })
        : null;

      // allSettled, not all: the two writes are independent, and `all` would
      // discard the other outcome the moment one rejects — which is exactly
      // the partial-success case this branch exists to report.
      const [roleResult, groupsResult] = await Promise.allSettled([
        rolePromise ?? Promise.resolve(),
        groupsPromise ?? Promise.resolve(),
      ]);

      const roleOk = !rolePromise || roleResult.status === "fulfilled";
      const groupsOk = !groupsPromise || groupsResult.status === "fulfilled";
      // The route's own wording ("Cannot change your own role", "License
      // required — Adding users to groups requires an active license.") beats
      // "Please try again", which tells the admin nothing they can act on.
      const reason = [roleResult, groupsResult]
        .map((r) =>
          r.status === "rejected" && r.reason instanceof ApiError ? r.reason.message : null
        )
        .find((m): m is string => m !== null);

      if (roleOk && groupsOk) {
        toast("User updated");
        onSaved();
        onOpenChange(false);
        return;
      }

      if (roleOk || groupsOk) {
        // Partial success: refetch so the list reflects the half that landed,
        // and keep the sheet open with a specific message so a retry only
        // re-applies the failed half. Use onRefresh (refetch-only), NOT onSaved
        // — the latter closes the sheet in the parent and would kill the retry.
        onRefresh?.();
        const half = !roleOk
          ? "Group membership saved, but the role change failed."
          : "Role saved, but group membership could not be updated.";
        toast.error(reason ? `${half} ${reason}` : `${half} Please retry.`);
        return;
      }

      // Total failure: nothing persisted, keep the sheet open.
      toast.error(reason ?? "Failed to update user. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleResetPassword() {
    try {
      const data = await apiPost<{ token: string }>(`/api/users/${user.id}/reset`, undefined);
      setResetLink(buildInviteUrl(window.location.origin, data.token));
    } catch (e) {
      toast.error(errorMessage(e, "Failed to reset password"));
    }
  }

  async function handleDeactivate() {
    try {
      await apiDelete(`/api/users/${user.id}`);
      setShowDeactivateConfirm(false);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setShowDeactivateConfirm(false);
      toast.error(errorMessage(e, "Failed to deactivate user"));
    }
  }

  async function handleReactivate() {
    try {
      await apiPost(`/api/users/${user.id}/reactivate`, undefined);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e, "Failed to reactivate user"));
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <div className="flex items-start justify-between">
            <div>
              <SheetTitle className="text-lg">{user.name}</SheetTitle>
              <SheetDescription>{user.email}</SheetDescription>
            </div>
            <StatusBadge status={user.status} />
          </div>
        </SheetHeader>

        <div className="flex flex-col gap-6 px-4 flex-1 overflow-y-auto">
          {/* Role */}
          <div className="space-y-2">
            <Label htmlFor="role-select">Role</Label>
            <Select
              value={selectedRole}
              // Radix hands back a bare string; the only two values it can
              // produce are the two SelectItems below, which are the role enum.
              onValueChange={(v) => setSelectedRole(v as UserRole)}
              disabled={isOwnAccount || isDeactivated}
            >
              <SelectTrigger id="role-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="member">Member</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Groups (enterprise only, when groups exist) */}
          {showGroups && (
            <div className="space-y-2">
              <Label>Groups</Label>
              <div className="space-y-2">
                {allGroups.map((group) => (
                  <label key={group.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selectedGroupIds.has(group.id)}
                      onCheckedChange={() => handleGroupToggle(group.id)}
                      disabled={isDeactivated || !canAddToGroup(group.id)}
                    />
                    {group.name}
                  </label>
                ))}
              </div>
              {!isEnterprise && (
                <p className="text-xs text-muted-foreground">
                  Adding to groups requires an active license. Removing always works.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="px-4 pb-4 space-y-4">
          {/* Save */}
          <Button onClick={handleSave} disabled={!isDirty || saving} className="w-full">
            {saving ? "Saving..." : "Save"}
          </Button>

          <Separator />

          {/* Actions */}
          <div className="space-y-2">
            <Button variant="outline" size="sm" className="w-full" onClick={handleResetPassword}>
              Reset Password
            </Button>

            {resetLink && (
              <div className="rounded border bg-muted p-3">
                <p className="text-sm font-medium mb-1">Reset link:</p>
                <p className="text-sm break-all">{resetLink}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => copyResetLink(resetLink)}
                >
                  {isResetLinkCopied ? "Copied!" : "Copy"}
                </Button>
              </div>
            )}

            {user.status === "active" ? (
              <Button
                variant="destructive"
                size="sm"
                className="w-full"
                disabled={isOwnAccount}
                onClick={() => setShowDeactivateConfirm(true)}
              >
                Deactivate
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="w-full" onClick={handleReactivate}>
                Reactivate
              </Button>
            )}
          </div>
        </div>
      </SheetContent>

      <AlertDialog
        open={showDeactivateConfirm}
        onOpenChange={(open) => !open && setShowDeactivateConfirm(false)}
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
            <AlertDialogAction variant="destructive" onClick={handleDeactivate}>
              Confirm Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
