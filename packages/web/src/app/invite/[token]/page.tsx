"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
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
import { CheckCircle2 } from "lucide-react";
import { PasswordInput } from "@/components/password-input";

const inviteClaimSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    password: z.string().min(12, "Password must be at least 12 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type InviteClaimValues = z.infer<typeof inviteClaimSchema>;

export default function InviteClaimPage() {
  const { token } = useParams();
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const form = useForm<InviteClaimValues>({
    resolver: zodResolver(inviteClaimSchema),
    defaultValues: { name: "", password: "", confirmPassword: "" },
  });

  async function onSubmit(values: InviteClaimValues) {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/invite/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: values.name, password: values.password }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create account");
        return;
      }

      setSuccess(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-full max-w-md flex flex-col items-center gap-6">
        <Image src="/pinchy-logo.png" alt="Pinchy" width={80} height={85} priority />

        <Card className="w-full">
          {success ? (
            <>
              <CardHeader className="text-center">
                <div className="flex justify-center mb-2">
                  <CheckCircle2 className="size-12 text-primary" />
                </div>
                <CardTitle>Account created!</CardTitle>
                <CardDescription>You can now sign in with your credentials.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => router.push("/login")} className="w-full">
                  Continue to sign in
                </Button>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader>
                <CardTitle>You&apos;ve been invited to Pinchy</CardTitle>
                <CardDescription>Set up your account to get started.</CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                    {error && <p className="text-destructive">{error}</p>}

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
                      {loading ? "Creating account..." : "Create account"}
                    </Button>
                  </form>
                </Form>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
