"use client";

import { useState, useEffect, useCallback, useOptimistic, useRef, useTransition } from "react";
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
import { SeatLimitDialog } from "@/components/seat-limit-dialog";
import { UserDetailSheet } from "@/components/user-detail-sheet";
import { StatusBadge } from "@/components/status-badge";
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
import { toast } from "sonner";
import { ShieldAlert, X } from "lucide-react";
import {
  mergeUserList,
  type ApiInvite,
  type ApiUser,
  type UserListItem,
  type UserGroup,
} from "@/lib/user-list";
import { useLicenseStatus } from "@/hooks/use-license-status";
import { CopyField } from "@/components/copy-field";
import { buildInviteUrl } from "@/lib/invite-url";
import { evaluateSeatPressure } from "@/lib/seat-grace";
import { SALES_MAILTO, CALENDLY_URL } from "@/lib/conversion-links";
import { apiGet, apiPost, apiDelete, errorMessage } from "@/lib/api-client";
import type { EmailDelivery, SystemMailStatus } from "@/lib/schemas/system-mail";
import type { AcknowledgeUserOriginInput, InviteUserInput } from "@/lib/schemas/users";

interface SettingsUsersProps {
  currentUserId: string;
  refreshKey?: number;
}

/**
 * Accounts neither the setup wizard nor a claimed invite created — in
 * practice, self-registered through the sign-up endpoint earlier releases left
 * open (GET /api/users flags them, lib/user-provenance.ts decides). Persistent
 * and actionable, so an inline banner rather than a toast (agent-rules/ui.md "Error And
 * Notification UI"); dismissing it hides it for this visit only, because the
 * accounts are still there until someone deactivates them.
 */
function UnknownOriginBanner({
  accounts,
  onReview,
  onMarkKnown,
  onDismiss,
}: {
  accounts: (UserListItem & { kind: "user" })[];
  onReview: (account: UserListItem & { kind: "user" }) => void;
  onMarkKnown: (account: UserListItem & { kind: "user" }) => void;
  onDismiss: () => void;
}) {
  return (
    <section
      aria-labelledby="unknown-origin-title"
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <ShieldAlert className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="space-y-2 min-w-0">
            <h2 id="unknown-origin-title" className="text-sm font-medium">
              {accounts.length === 1
                ? "1 account nobody invited"
                : `${accounts.length} accounts nobody invited`}
            </h2>
            <p className="text-sm text-muted-foreground">
              Every account comes from the setup wizard or a claimed invite, and{" "}
              {accounts.length === 1 ? "this one doesn't" : "these don't"}. Earlier versions of
              Pinchy let anyone who could reach it sign up on their own. If you don&apos;t recognise
              an account here, review it and deactivate it. If you do, mark it as known.
            </p>
            <ul className="space-y-1">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
                >
                  <span className="font-medium truncate max-w-[200px]" title={account.name}>
                    {account.name}
                  </span>
                  <span
                    className="text-muted-foreground truncate max-w-[260px]"
                    title={account.email}
                  >
                    {account.email}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Review ${account.name}`}
                    onClick={() => onReview(account)}
                  >
                    Review
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Mark ${account.name} as known`}
                    onClick={() => onMarkKnown(account)}
                  >
                    Mark as known
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          className="shrink-0"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </section>
  );
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
  const [seatLimitOpen, setSeatLimitOpen] = useState(false);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [resendDelivery, setResendDelivery] = useState<{
    email: string;
    delivery: EmailDelivery;
  } | null>(null);
  const [selectedUser, setSelectedUser] = useState<(UserListItem & { kind: "user" }) | null>(null);
  const [allGroups, setAllGroups] = useState<{ id: string; name: string }[]>([]);
  // The first load failed, so an empty table would read as "no users".
  const [loadFailed, setLoadFailed] = useState(false);
  const loaded = useRef(false);
  // Refreshed with the list (fetchUsers), since seat usage moves with it.
  const { license, refetch: refetchLicense } = useLicenseStatus({
    enabled: false,
    notifyOnFailure: true,
  });
  // null = unknown: hide group features rather than claim there is no license.
  const isEnterprise = license?.enterprise ?? null;
  const seatInfo =
    typeof license?.maxUsers === "number" && typeof license?.seatsUsed === "number"
      ? { maxUsers: license.maxUsers, seatsUsed: license.seatsUsed }
      : null;
  const [unknownOriginDismissed, setUnknownOriginDismissed] = useState(false);
  // "Mark as known" cannot be undone — the acknowledgement is an audit row and
  // nothing withdraws it — so it asks first, like Deactivate does.
  const [confirmKnown, setConfirmKnown] = useState<(UserListItem & { kind: "user" }) | null>(null);

  // Already-deactivated accounts need no action, so they stay out of the banner.
  const unknownOriginAccounts = items.filter(
    (i): i is UserListItem & { kind: "user" } =>
      i.kind === "user" && i.unknownOrigin && i.status === "active"
  );

  const pressure = seatInfo ? evaluateSeatPressure(seatInfo.seatsUsed, seatInfo.maxUsers) : null;
  const showCounter = seatInfo !== null && seatInfo.maxUsers > 0;

  // `signal` comes from the mount effect, which aborts it on cleanup. The
  // refreshes after a mutation pass none and run to completion.
  const fetchUsers = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [usersData, invitesData, groupsData] = await Promise.all([
          apiGet<{ users: ApiUser[] }>("/api/users", { signal }),
          apiGet<{ invites: ApiInvite[] }>("/api/users/invites", { signal }),
          // Groups only decorate the rows; a failure here leaves the badges
          // off rather than the whole list. `null` is "not loaded this time".
          apiGet<UserGroup[]>("/api/groups", { signal }).catch(() => null),
          refetchLicense(),
        ]);
        if (signal?.aborted) return;
        setItems(mergeUserList(usersData.users, invitesData.invites));
        // A refresh that loses the groups keeps the ones already known: the
        // open sheet would otherwise hide its group checkboxes mid-retry.
        if (Array.isArray(groupsData)) setAllGroups(groupsData);
        else if (!loaded.current) setAllGroups([]);
        loaded.current = true;
        setLoadFailed(false);
      } catch (err) {
        // Classify on the signal alone: an abort's error is not reliably an
        // AbortError (see audit-log-table.tsx).
        if (signal?.aborted) return;
        // The tab loads in the background, so a toast about the first load is
        // gone before anyone opens it: that one stands where the list would.
        // A failed refresh leaves the loaded list up and says so in a toast.
        if (loaded.current) toast.error(errorMessage(err, "Failed to load users"));
        else setLoadFailed(true);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [refetchLicense]
  );

  useEffect(() => {
    // Deferred past the effect body (react-hooks/set-state-in-effect), same
    // pattern as settings-groups.tsx.
    const controller = new AbortController();
    const { signal } = controller;
    void Promise.resolve().then(() => {
      if (!signal.aborted) void fetchUsers(signal);
    });
    return () => controller.abort();
  }, [fetchUsers, refreshKey]);

  useEffect(() => {
    if (!selectedUser || !isEnterprise) return;
    // Picks up groups created since the list loaded. A failure keeps the ones
    // already known: the sheet hides its groups section when it has none.
    apiGet<UserGroup[]>("/api/groups")
      .then((data) => {
        if (Array.isArray(data)) setAllGroups(data);
      })
      .catch(() => {});
  }, [selectedUser, isEnterprise]);

  function handleRevoke(inviteId: string) {
    startRevokeTransition(async () => {
      applyOptimistic({ type: "removeInvite", id: inviteId });
      try {
        await apiDelete(`/api/users/invites/${inviteId}`);
      } catch (e) {
        // fetchUsers() re-introduces the optimistically-removed row on failure;
        // surface why it flickered back instead of failing silently. The route's
        // own wording ("Invite not found") tells a stale list from an outage.
        toast.error(errorMessage(e, "Failed to revoke invite. Please try again."));
      }
      fetchUsers();
    });
  }

  async function handleMarkKnown(account: UserListItem & { kind: "user" }) {
    // Recorded in the audit trail as user.origin_acknowledged; the provenance
    // check reads that row, so the account leaves the banner on the refetch.
    try {
      await apiPost<{ success: true }, AcknowledgeUserOriginInput>(
        `/api/users/${account.id}/acknowledge-origin`,
        {}
      );
      toast.success(`Marked ${account.name} as known`);
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't mark the account as known. Please try again."));
    }
    fetchUsers();
  }

  async function handleResend(item: UserListItem & { kind: "invite" }) {
    // Resend = revoke the old invite, then create a fresh one. Report which of
    // the two steps failed so the admin knows whether the old invite is still
    // live (revoke failed) or simply no replacement was issued (create failed).
    //
    // Only offered for invites that have an email: one created before the
    // email became required gets Revoke instead (#1263).
    const email = item.email;
    if (!email) return; // unreachable: such a row shows Revoke; narrows the type
    setResendDelivery(null);
    try {
      await apiDelete(`/api/users/invites/${item.id}`);
    } catch (e) {
      toast.error(errorMessage(e, "Failed to revoke the old invite. Please try again."));
      fetchUsers();
      return;
    }
    // With a system mailer (#1309) the fresh invite is emailed too, like one
    // from the invite dialog. Unknown status means "don't promise an email".
    const mailConfigured = await apiGet<SystemMailStatus>("/api/settings/mail")
      .then((s) => s.configured === true)
      .catch(() => false);
    try {
      const data = await apiPost<{ token: string; emailDelivery?: EmailDelivery }, InviteUserInput>(
        "/api/users/invite",
        { email, role: item.role, ...(mailConfigured ? { sendEmail: true } : {}) }
      );
      setResetLink(buildInviteUrl(window.location.origin, data.token));
      setResendDelivery(data.emailDelivery ? { email, delivery: data.emailDelivery } : null);
    } catch (e) {
      toast.error(errorMessage(e, "Failed to create the new invite. Please try again."));
    }
    fetchUsers();
  }

  if (loading) {
    return <p>Loading...</p>;
  }

  if (loadFailed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="alert" className="text-sm text-red-600">
            We couldn&apos;t load the user list. Reload the page to try again.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {unknownOriginAccounts.length > 0 && !unknownOriginDismissed && (
        <UnknownOriginBanner
          accounts={unknownOriginAccounts}
          onReview={setSelectedUser}
          onMarkKnown={setConfirmKnown}
          onDismiss={() => setUnknownOriginDismissed(true)}
        />
      )}
      <AlertDialog open={!!confirmKnown} onOpenChange={(open) => !open && setConfirmKnown(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark {confirmKnown?.name} as known?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmKnown?.name} leaves this check for good — there&apos;s no way to put an
              account back on the list. The audit trail records that you vouched for it. Only do
              this if you know where the account came from.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmKnown) void handleMarkKnown(confirmKnown);
                setConfirmKnown(null);
              }}
            >
              Mark as known
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Users</CardTitle>
          <Button
            onClick={() => {
              // Beyond the grace cap the endpoint would reject the invite —
              // surface the quote path instead of a doomed form (§ 5).
              if (pressure && !pressure.inviteAllowed) {
                setSeatLimitOpen(true);
              } else {
                setInviteOpen(true);
              }
            }}
          >
            Invite User
          </Button>
        </CardHeader>
        <CardContent>
          {resendDelivery?.delivery.sent === true && (
            <p role="status" className="mb-2 text-sm">
              Invitation sent to {resendDelivery.email}.
            </p>
          )}
          {resendDelivery?.delivery.sent === false && (
            <p role="alert" className="mb-2 text-sm text-destructive">
              We couldn&apos;t send the email ({resendDelivery.delivery.error}). Copy the link below
              and send it yourself.
            </p>
          )}
          {resetLink && (
            <div className="mb-4 space-y-1 rounded border p-3">
              <p id="resent-invite-link-label" className="text-sm font-medium">
                Invite link:
              </p>
              <CopyField
                value={resetLink}
                label="Invite link"
                labelledBy="resent-invite-link-label"
                copyLabel="Copy link"
                share={{ title: "Pinchy invite" }}
                autoFocus
              />
            </div>
          )}

          {showCounter && (
            <div className="mb-4 rounded-md border p-3 text-sm bg-muted text-muted-foreground">
              {`${seatInfo!.seatsUsed} of ${seatInfo!.maxUsers} seats used.`}
              {pressure?.overCap && (
                <>
                  {" "}
                  Grace seats keep a new hire from waiting on procurement.{" "}
                  <a href={SALES_MAILTO} className="underline">
                    Email us for a quote
                  </a>{" "}
                  <span className="opacity-60">·</span>{" "}
                  <a
                    href={CALENDLY_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Book a call
                  </a>
                </>
              )}
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
                  {item.kind === "invite" && (item.status === "pending" || !item.email) && (
                    <Button variant="outline" size="sm" onClick={() => handleRevoke(item.id)}>
                      Revoke
                    </Button>
                  )}
                  {item.kind === "invite" && item.status === "expired" && item.email && (
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
                      {item.kind === "invite" && (item.status === "pending" || !item.email) && (
                        <Button variant="outline" size="sm" onClick={() => handleRevoke(item.id)}>
                          Revoke
                        </Button>
                      )}
                      {item.kind === "invite" && item.status === "expired" && item.email && (
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

      {seatInfo !== null && pressure !== null && pressure.graceCap !== null && (
        <SeatLimitDialog
          open={seatLimitOpen}
          onOpenChange={setSeatLimitOpen}
          maxUsers={seatInfo.maxUsers}
          graceCap={pressure.graceCap}
        />
      )}

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
          // Partial success: refresh the list but keep the sheet open so the
          // user can retry the half that failed (no setSelectedUser(null)).
          onRefresh={fetchUsers}
        />
      )}
    </div>
  );
}
