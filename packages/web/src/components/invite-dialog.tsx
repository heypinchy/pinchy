"use client";

import { useState, useEffect } from "react";
import { CopyField } from "@/components/copy-field";
import { buildInviteUrl } from "@/lib/invite-url";
import { apiGet, apiPost, errorMessage } from "@/lib/api-client";
import type { EmailDelivery, SystemMailStatus } from "@/lib/schemas/system-mail";
import { inviteUserSchema, type InviteUserInput } from "@/lib/schemas/users";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

// Derived from the route's schema so the two can't drift; only the email is
// redefined, to give the form its own messages. It is required: the invitee's
// account is created with this address, so an invite without one could never
// be claimed (#1263).
const inviteSchema = inviteUserSchema.pick({ role: true }).extend({
  email: z.string().trim().min(1, "Email is required").pipe(z.email("Invalid email")),
});

type InviteFormValues = z.infer<typeof inviteSchema>;

type CreatedInvite = { url: string; email: string; expiresAt: string | null };

// Rendered in the admin's time zone, and named, because they may pass the
// deadline on to someone in another one. en-US for the same reason as
// lib/format-date.ts: an English month name can't be misread as 4/8 vs 8/4.
function formatExpiry(iso: string): string {
  const date = new Date(iso);
  const when = date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  return zone ? `${when} ${zone}` : when;
}

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InviteDialog({ open, onOpenChange }: InviteDialogProps) {
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const inviteLink = created?.url ?? null;
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [isEnterprise, setIsEnterprise] = useState<boolean | null>(null);
  const [seatInfo, setSeatInfo] = useState<{ maxUsers: number; seatsUsed: number } | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  // With a system mailer (#1309) the dialog emails the invitation; the link
  // is still shown either way, so copying it always works.
  const [mailConfigured, setMailConfigured] = useState(false);
  const [emailDelivery, setEmailDelivery] = useState<EmailDelivery | null>(null);

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: {
      email: "",
      role: "member",
    },
  });

  // Reset form when dialog closes — uses React-recommended
  // "adjust state during render" pattern instead of useEffect.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (!open) {
      form.reset();
      setCreated(null);
      setError(null);
      setEmailDelivery(null);
      setSelectedGroupIds([]);
    }
  }

  useEffect(() => {
    if (!open) return;
    fetch("/api/enterprise/status")
      .then((r) => r.json())
      .then((d) => {
        setIsEnterprise(d.enterprise);
        if (typeof d.maxUsers === "number" && typeof d.seatsUsed === "number") {
          setSeatInfo({ maxUsers: d.maxUsers, seatsUsed: d.seatsUsed });
        }
      })
      .catch(() => setIsEnterprise(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    apiGet<SystemMailStatus>("/api/settings/mail")
      .then((s) => setMailConfigured(s.configured === true))
      // Unknown means "don't promise an email": the link path always works.
      .catch(() => setMailConfigured(false));
  }, [open]);

  useEffect(() => {
    if (!open || !isEnterprise) return;
    fetch("/api/groups")
      .then((r) => r.json())
      .then((data) => setGroups(Array.isArray(data) ? data : []))
      .catch(() => setGroups([]));
  }, [open, isEnterprise]);

  async function onSubmit(values: InviteFormValues) {
    setError(null);
    setCreating(true);
    try {
      const data = await apiPost<
        { token: string; expiresAt?: string; emailDelivery?: EmailDelivery },
        InviteUserInput
      >("/api/users/invite", {
        email: values.email,
        role: values.role,
        ...(selectedGroupIds.length > 0 ? { groupIds: selectedGroupIds } : {}),
        ...(mailConfigured ? { sendEmail: true } : {}),
      });
      setCreated({
        url: buildInviteUrl(window.location.origin, data.token),
        email: values.email,
        expiresAt: data.expiresAt ?? null,
      });
      setEmailDelivery(data.emailDelivery ?? null);
    } catch (e) {
      // Seat-cap 403s carry an actionable message beside the terse headline
      // (quote path, § 5); ApiError.message already joins the two.
      setError(errorMessage(e, "Failed to create invite"));
    } finally {
      setCreating(false);
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite User</DialogTitle>
          <DialogDescription>Create an invite link to add a new user.</DialogDescription>
        </DialogHeader>

        {!inviteLink &&
          seatInfo &&
          seatInfo.maxUsers > 0 &&
          seatInfo.seatsUsed > seatInfo.maxUsers && (
            <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
              You&apos;re using {seatInfo.seatsUsed} of {seatInfo.maxUsers} licensed seats. Grace
              seats keep a new hire from waiting on procurement.
            </div>
          )}

        {inviteLink ? (
          <div className="space-y-4">
            {emailDelivery?.sent === true && (
              <p role="status" className="text-sm">
                Invitation sent to {created?.email}.
              </p>
            )}
            {emailDelivery?.sent === false && (
              <p role="alert" className="text-sm text-destructive">
                We couldn&apos;t send the email ({emailDelivery.error}). Copy the link below and
                send it yourself.
              </p>
            )}
            <p className="text-sm font-medium">Invite link created:</p>
            <CopyField
              value={inviteLink}
              label="Invite link"
              copyLabel="Copy link"
              share={{ title: "Pinchy invite" }}
              autoFocus
            />
            {/* Without email delivery (#1309), an email field reads as if
                Pinchy mails the invite. It doesn't — the admin delivers the
                link (#1265). With a mailer, the status line above says what
                happened instead. */}
            <div className="space-y-1 text-sm text-muted-foreground">
              {!emailDelivery && (
                <p>
                  Pinchy doesn&apos;t email this link. Copy it and send it to {created?.email}{" "}
                  yourself.
                </p>
              )}
              {created?.expiresAt && (
                <p>The link works once and expires on {formatExpiry(created.expiresAt)}.</p>
              )}
            </div>
          </div>
        ) : (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              method="post"
              noValidate
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="user@example.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select role" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {isEnterprise && groups.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Groups</Label>
                  {groups.map((group) => (
                    <div key={group.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`group-${group.id}`}
                        checked={selectedGroupIds.includes(group.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedGroupIds([...selectedGroupIds, group.id]);
                          } else {
                            setSelectedGroupIds(selectedGroupIds.filter((id) => id !== group.id));
                          }
                        }}
                      />
                      <Label htmlFor={`group-${group.id}`} className="text-sm font-normal">
                        {group.name}
                      </Label>
                    </div>
                  ))}
                </div>
              )}
              {error && <p className="text-destructive text-sm">{error}</p>}
              <Button type="submit" disabled={creating}>
                {mailConfigured ? "Send invitation" : "Create Invite"}
              </Button>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
