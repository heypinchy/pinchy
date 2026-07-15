"use client";

import { Suspense, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { isSafeReturnTo } from "@/lib/return-to";
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

/**
 * Turns a Better Auth sign-in failure into the message the user sees.
 *
 * Only a credential rejection may be reported as a wrong password. Better Auth
 * answers a throttled sign-in with 429 (see `getAuthRateLimitConfig`: 5
 * attempts / 60s, active whenever NODE_ENV=production) and a broken backend
 * with 5xx. Reporting those as "Invalid email or password" sends the user
 * hunting for a password that was right all along — and because every retry
 * re-arms the rate-limit window, hammering the button keeps them locked out
 * while the page insists their credentials are bad.
 *
 * A failure without a status is treated as a credential rejection: that is
 * Better Auth's own default shape for a rejected sign-in.
 */
function loginErrorMessage(status: number | undefined): string {
  if (status === 429) {
    return "Too many sign-in attempts. Please wait a minute and try again.";
  }
  if (status === undefined || status === 401 || status === 403) {
    return "Invalid email or password";
  }
  return "Login failed. Please try again.";
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
      setError("Login failed. Please try again.");
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
                {error && <p className="text-destructive">{error}</p>}

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
