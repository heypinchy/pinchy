"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PasswordInput } from "@/components/password-input";
import { passwordSchema } from "@/lib/validate-password";

// The /invite/[token] page serves two flows that share the same token table
// (#436): a brand-new user claiming an invite, and an existing user resetting
// their password. They differ in copy and — crucially — the reset flow must
// NOT collect a display name, because submitting one used to silently
// overwrite the user's existing name.
type InviteType = "invite" | "reset";

const passwordRefine = {
  check: (data: { password: string; confirmPassword: string }) =>
    data.password === data.confirmPassword,
  options: { message: "Passwords do not match", path: ["confirmPassword"] },
};

const inviteClaimSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine(passwordRefine.check, passwordRefine.options);

const resetSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine(passwordRefine.check, passwordRefine.options);

type FormValues = {
  name?: string;
  password: string;
  confirmPassword: string;
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

const SUCCESS_COPY: Record<InviteType, { title: string; description: string }> = {
  invite: {
    title: "Account created!",
    description: "You can now sign in with your credentials.",
  },
  reset: {
    title: "Password reset!",
    description: "You can now sign in with your new password.",
  },
};

export default function InviteClaimPage() {
  const { token } = useParams();
  const [type, setType] = useState<InviteType | null>(null);
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
        setType(data.type === "reset" ? "reset" : "invite");
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
          ) : type === null ? (
            <CardContent className="flex justify-center py-10" role="status" aria-label="Loading">
              <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
            </CardContent>
          ) : (
            <ClaimForm token={String(token)} type={type} />
          )}
        </Card>
      </div>
    </div>
  );
}

function ClaimForm({ token, type }: { token: string; type: InviteType }) {
  const router = useRouter();
  const isReset = type === "reset";
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(isReset ? resetSchema : inviteClaimSchema),
    defaultValues: isReset
      ? { password: "", confirmPassword: "" }
      : { name: "", password: "", confirmPassword: "" },
  });

  async function onSubmit(values: FormValues) {
    setLoading(true);

    const body = isReset
      ? { token, password: values.password }
      : { token, name: values.name, password: values.password };

    try {
      const res = await fetch("/api/invite/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        // Submit failures (expired link, server error) are system-level, not
        // field-correctable, so they surface as a toast per the error-display
        // policy. Field validation stays inline via <FormMessage>.
        toast.error(
          data.error || (isReset ? "Failed to reset password" : "Failed to create account")
        );
        return;
      }

      setSuccess(true);
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    const copy = isReset ? SUCCESS_COPY.reset : SUCCESS_COPY.invite;
    return (
      <>
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <CheckCircle2 className="size-12 text-primary" />
          </div>
          <CardTitle>{copy.title}</CardTitle>
          <CardDescription>{copy.description}</CardDescription>
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
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
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
                  <PasswordInput {...field} />
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirm password</FormLabel>
                  <PasswordInput {...field} />
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
