"use client";

import { useState, useEffect } from "react";
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

const inviteSchema = z.object({
  email: z.email("Invalid email").optional().or(z.literal("")),
  role: z.enum(["member", "admin"]),
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
  const [copied, setCopied] = useState(false);
  const [isEnterprise, setIsEnterprise] = useState<boolean | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: {
      email: "",
      role: "member",
    },
  });

  useEffect(() => {
    if (!open) {
      form.reset();
      setInviteLink(null);
      setError(null);
      setCopied(false);
      setSelectedGroupIds([]);
    }
  }, [open, form]);

  useEffect(() => {
    if (!open) return;
    fetch("/api/enterprise/status")
      .then((r) => r.json())
      .then((d) => setIsEnterprise(d.enterprise))
      .catch(() => setIsEnterprise(false));
  }, [open]);

  useEffect(() => {
    if (!open || !isEnterprise) return;
    fetch("/api/groups")
      .then((r) => r.json())
      .then((data) => setGroups(Array.isArray(data) ? data : []));
  }, [open, isEnterprise]);

  async function onSubmit(values: InviteFormValues) {
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: values.email,
          role: values.role,
          ...(selectedGroupIds.length > 0 ? { groupIds: selectedGroupIds } : {}),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setInviteLink(`${window.location.origin}/invite/${data.token}`);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to create invite");
      }
    } catch {
      setError("Failed to create invite");
    } finally {
      setCreating(false);
    }
  }

  const canShare =
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function";

  async function handleShare() {
    if (inviteLink && canShare) {
      try {
        await navigator.share({ title: "Pinchy Invite", url: inviteLink });
      } catch {
        // User cancelled share — ignore
      }
    }
  }

  async function handleCopy() {
    if (inviteLink) {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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

        {inviteLink ? (
          <div className="space-y-4">
            <p className="text-sm font-medium">Invite link created:</p>
            <p className="text-sm break-all bg-muted p-2 rounded">{inviteLink}</p>
            {canShare ? (
              <Button onClick={handleShare}>Share</Button>
            ) : (
              <Button onClick={handleCopy}>{copied ? "Copied!" : "Copy"}</Button>
            )}
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email (optional)</FormLabel>
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
