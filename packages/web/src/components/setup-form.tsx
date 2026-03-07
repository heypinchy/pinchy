"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
import { CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import { ReportIssueLink } from "@/components/report-issue-link";

const setupSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type SetupFormValues = z.infer<typeof setupSchema>;

interface InfrastructureStatus {
  database: "connected" | "unreachable";
  openclaw: "connected" | "unreachable";
}

type PreflightState =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "error"; infrastructure: InfrastructureStatus };

function usePreflightCheck() {
  const [state, setState] = useState<PreflightState>({ status: "checking" });

  const [checkTrigger, setCheckTrigger] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/setup/status")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const infra = data.infrastructure as InfrastructureStatus | undefined;
        if (infra && (infra.database === "unreachable" || infra.openclaw === "unreachable")) {
          setState({ status: "error", infrastructure: infra });
        } else {
          setState({ status: "ready" });
        }
      })
      .catch(() => {
        if (cancelled) return;
        // If status check itself fails, show form anyway (graceful fallback)
        setState({ status: "ready" });
      });
    return () => {
      cancelled = true;
    };
  }, [checkTrigger]);

  const retry = () => {
    setState({ status: "checking" });
    setCheckTrigger((n) => n + 1);
  };

  return { state, retry };
}

export function SetupForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const { state: preflight, retry } = usePreflightCheck();

  const form = useForm<SetupFormValues>({
    resolver: zodResolver(setupSchema),
    defaultValues: { name: "", email: "", password: "" },
  });

  async function onSubmit(values: SetupFormValues) {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          password: values.password,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Setup failed");
      }

      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  }

  if (preflight.status === "checking") {
    return (
      <Card className="w-full">
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin mr-2 text-muted-foreground" />
          <span className="text-muted-foreground">Checking infrastructure...</span>
        </CardContent>
      </Card>
    );
  }

  if (preflight.status === "error") {
    const { infrastructure } = preflight;
    const issues: string[] = [];
    if (infrastructure.database === "unreachable") issues.push("Database is unreachable");
    if (infrastructure.openclaw === "unreachable") issues.push("OpenClaw is unreachable");
    const errorMessage = issues.join(". ");

    return (
      <Card className="w-full">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <AlertTriangle className="size-12 text-destructive" />
          </div>
          <CardTitle>Infrastructure Problem</CardTitle>
          <CardDescription>
            Pinchy can&apos;t start setup because required services are not available.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md bg-destructive/10 p-4 text-sm space-y-1">
            {infrastructure.database === "unreachable" && (
              <p>
                <strong>Database:</strong> unreachable
              </p>
            )}
            {infrastructure.openclaw === "unreachable" && (
              <p>
                <strong>OpenClaw:</strong> unreachable
              </p>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Check that all containers are running with{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">docker compose ps</code> and
            review the logs with{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">docker compose logs</code>.
          </p>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={retry}
              className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-2 cursor-pointer"
            >
              Try again
            </button>
            <ReportIssueLink error={errorMessage} />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      {success ? (
        <>
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <CheckCircle2 className="size-12 text-primary" />
            </div>
            <CardTitle>Account created successfully!</CardTitle>
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
            <CardTitle>Welcome to Pinchy</CardTitle>
            <CardDescription>
              Create your admin account. You&apos;ll use these credentials to sign in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
                {error && (
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-destructive">{error}</p>
                    <ReportIssueLink error={error} />
                  </div>
                )}

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
                        <Input type="password" {...field} />
                      </FormControl>
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
  );
}
