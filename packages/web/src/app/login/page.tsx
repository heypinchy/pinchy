"use client";

import { Suspense, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { isSafeReturnTo } from "@/lib/return-to";
import { SIGN_IN_RATE_LIMIT_WINDOW_SECONDS } from "@/lib/auth-rate-limit";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/password-input";
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

const loginSchema = z.object({
  email: z.email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

/** Shown when we can't tell the user anything more specific than "it failed". */
const GENERIC_LOGIN_ERROR = "Login failed. Please try again.";

/**
 * Turns a Better Auth sign-in failure into the message the user sees.
 *
 * Only a 401 may be reported as a wrong password. Better Auth answers every
 * credential rejection with 401/INVALID_EMAIL_OR_PASSWORD — unknown user,
 * missing account and bad password alike. Reporting anything else that way
 * sends the user hunting for a password that was right all along.
 *
 * 429 is a throttled sign-in (see `getAuthRateLimitConfig`: 5 attempts per
 * window, active whenever NODE_ENV=production). Because every retry re-arms the
 * window, hammering the button keeps the user locked out while the page insists
 * their credentials are bad.
 *
 * 403 is never a wrong password — it is only reachable *after* the password
 * verified. It means the account is banned (the admin plugin's
 * `session.create.before` hook, which is how Pinchy deactivates a user) or its
 * email is unverified. Naming the password there hides the only fact that would
 * help, and the user cannot fix it alone. Saying so leaks nothing: whoever sees
 * a 403 has already proven the correct password.
 */
function loginErrorMessage(status: number | undefined): string {
  if (status === 429) {
    return `Too many sign-in attempts. Please wait ${SIGN_IN_RATE_LIMIT_WINDOW_SECONDS} seconds and try again.`;
  }
  if (status === 401) {
    return "Invalid email or password";
  }
  if (status === 403) {
    return "This account can't sign in. Please contact your administrator.";
  }
  return GENERIC_LOGIN_ERROR;
}

export default function LoginPage() {
  // useSearchParams() opts the render into a Suspense boundary (Next.js
  // requires one so the rest of the page can still be statically
  // prerendered) — see
  // https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: LoginFormValues) {
    setLoading(true);
    setError("");

    try {
      const { error } = await authClient.signIn.email({
        email: values.email,
        password: values.password,
      });

      if (error) {
        setError(loginErrorMessage(error.status));
      } else {
        const returnTo = searchParams.get("returnTo");
        router.push(isSafeReturnTo(returnTo) ? returnTo : "/");
      }
    } catch {
      setError(GENERIC_LOGIN_ERROR);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md flex flex-col items-center gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pinchy-logo.svg" alt="Pinchy" width={80} height={85} />

        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in to Pinchy</CardTitle>
            <CardDescription>Enter your email and password to continue.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                method="post"
                noValidate
                className="space-y-6"
              >
                {/* role="alert" so the failure reaches screen-reader users too:
                    the message appears without a navigation or focus change,
                    which is otherwise silent. */}
                {error && (
                  <p role="alert" className="text-destructive">
                    {error}
                  </p>
                )}

                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input type="email" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <PasswordInput {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? "Signing in..." : "Sign in"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
