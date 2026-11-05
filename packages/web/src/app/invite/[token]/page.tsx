"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PasswordInput } from "@/components/password-input";
import { PASSWORD_RULE_HINT, passwordSchema } from "@/lib/validate-password";
import { apiPost, errorMessage } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import { enterAccount } from "@/lib/account-switch";
import type { ClaimInviteInput, InviteTokenInfo } from "@/lib/schemas/invite";

// The /invite/[token] page serves two flows that share the same token table
// (#436): a brand-new user claiming an invite, and an existing user resetting
// their password. They differ in copy and — crucially — the reset flow must
// NOT collect a display name, because submitting one used to silently
// overwrite the user's existing name.
type InviteType = InviteTokenInfo["type"];

// No "Confirm password" field (#1265): the show/hide toggle catches a typo
// better than retyping does, and the rule is stated up front.
const inviteClaimSchema = z.object({
  name: z.string().min(1, "Name is required"),
  password: passwordSchema,
});

const resetSchema = z.object({
  password: passwordSchema,
});

type FormValues = {
  name?: string;
  password: string;
};

const COPY: Record<
  InviteType,
  { title: string; description: string; submit: string; busy: string }
> = {
  invite: {
    title: "You've been invited to Pinchy",
    description: "Set up your account to get started.",
    submit: "Create account",
    busy: "Creating account...",
  },
  reset: {
    title: "Reset your Pinchy password",
    description: "Set a new password for your account.",
    submit: "Reset password",
    busy: "Resetting password...",
  },
};

// Shown only when signing in right after the claim failed (see onSubmit).
const SUCCESS_TITLE: Record<InviteType, string> = {
  invite: "Account created!",
  reset: "Password reset!",
};

// Naming the inviter makes an unexpected link from an admin read less like
// phishing (#1265). There is no organisation name to show: Pinchy stores none.
function inviteTitle(invitedBy: string | null) {
  return invitedBy ? `${invitedBy} invited you to Pinchy` : COPY.invite.title;
}

// The user lands on /login next and has to type this address, so say it.
function successDescription(email: string) {
  return `You can now sign in with ${email} and your new password.`;
}

export default function InviteClaimPage() {
  const { token } = useParams();
  const [info, setInfo] = useState<InviteTokenInfo | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadType() {
      try {
        const res = await fetch(`/api/invite/${token}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data.error || "Invalid or expired invite link");
          return;
        }
        if (typeof data.email !== "string" || !data.email) {
          setLoadError("Invalid or expired invite link");
          return;
        }
        setInfo({
          type: data.type === "reset" ? "reset" : "invite",
          email: data.email,
          invitedBy: typeof data.invitedBy === "string" ? data.invitedBy : null,
        });
      } catch {
        if (!cancelled) setLoadError("Something went wrong. Please try again.");
      }
    }
    loadType();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-full max-w-md flex flex-col items-center gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pinchy-logo.svg" alt="Pinchy" width={80} height={85} />

        <Card className="w-full">
          {loadError ? (
            <CardHeader>
              <CardTitle>This link can&apos;t be used</CardTitle>
              <CardDescription className="text-destructive">{loadError}</CardDescription>
            </CardHeader>
          ) : info === null ? (
            <CardContent className="flex justify-center py-10" role="status" aria-label="Loading">
              <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
            </CardContent>
          ) : (
            <ClaimForm token={String(token)} info={info} />
          )}
        </Card>
      </div>
    </div>
  );
}

function ClaimForm({ token, info }: { token: string; info: InviteTokenInfo }) {
  const { type, email, invitedBy } = info;
  const router = useRouter();
  const isReset = type === "reset";
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(isReset ? resetSchema : inviteClaimSchema),
    defaultValues: isReset ? { password: "" } : { name: "", password: "" },
  });

  async function onSubmit(values: FormValues) {
    setLoading(true);

    const body: ClaimInviteInput = isReset
      ? { token, password: values.password }
      : { token, name: values.name, password: values.password };

    try {
      await apiPost<unknown, ClaimInviteInput>("/api/invite/claim", body);
    } catch (e) {
      // Submit failures (expired link, server error) are system-level, not
      // field-correctable, so they surface as a toast per the error-display
      // policy. Field validation stays inline via <FormMessage>.
      toast.error(
        errorMessage(e, isReset ? "Failed to reset password" : "Failed to create account")
      );
      setLoading(false);
      return;
    }

    // The account exists and the password is known, so sign in right away
    // instead of sending the person to /login to type both again (#1265).
    // Through the ordinary sign-in endpoint on purpose: its rate limit, the
    // deactivation hook and the session cookie stay exactly as on /login.
    // If it fails for any reason, the success screen still says what to
    // sign in with, which is where this page used to stop anyway.
    try {
      const { data, error } = await authClient.signIn.email({ email, password: values.password });
      if (!error && data) {
        await enterAccount(data.user.id, "/");
        return;
      }
    } catch {
      // Fall through to the success screen.
    }
    setSuccess(true);
    setLoading(false);
  }

  if (success) {
    return (
      <>
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <CheckCircle2 className="size-12 text-primary" />
          </div>
          <CardTitle>{SUCCESS_TITLE[type]}</CardTitle>
          <CardDescription>{successDescription(email)}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => router.push("/login")} className="w-full">
            Continue to sign in
          </Button>
        </CardContent>
      </>
    );
  }

  const copy = isReset ? COPY.reset : COPY.invite;
  return (
    <>
      <CardHeader>
        <CardTitle>{isReset ? copy.title : inviteTitle(invitedBy)}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} method="post" className="space-y-6">
            {/* Not a form field: the invite fixes the address, and the claim
                never sends it. `autoComplete="username"` lets a password
                manager store the new password against it. */}
            <div className="grid gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                readOnly
                autoComplete="username"
                className="bg-muted text-muted-foreground"
              />
            </div>

            {!isReset && (
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input type="text" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <PasswordInput autoComplete="new-password" {...field} />
                  <FormDescription>{PASSWORD_RULE_HINT}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? copy.busy : copy.submit}
            </Button>
          </form>
        </Form>
      </CardContent>
    </>
  );
}
