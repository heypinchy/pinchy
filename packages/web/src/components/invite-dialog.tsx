"use client";

import { useState, useEffect } from "react";
import { CopyField } from "@/components/copy-field";
import { buildInviteUrl } from "@/lib/invite-url";
import { apiPost, errorMessage } from "@/lib/api-client";
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

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InviteDialog({ open, onOpenChange }: InviteDialogProps) {
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [isEnterprise, setIsEnterprise] = useState<boolean | null>(null);
  const [seatInfo, setSeatInfo] = useState<{ maxUsers: number; seatsUsed: number } | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);

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
      setInviteLink(null);
      setError(null);
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
      const data = await apiPost<{ token: string }, InviteUserInput>("/api/users/invite", {
        email: values.email,
        role: values.role,
        ...(selectedGroupIds.length > 0 ? { groupIds: selectedGroupIds } : {}),
      });
      setInviteLink(buildInviteUrl(window.location.origin, data.token));
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
            <p className="text-sm font-medium">Invite link created:</p>
            <CopyField
              value={inviteLink}
              label="Invite link"
              copyLabel="Copy link"
              share={{ title: "Pinchy Invite" }}
            />
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
                Create Invite
              </Button>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
