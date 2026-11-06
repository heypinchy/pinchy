"use client";

import { useState } from "react";
import { leaveAccount } from "@/lib/account-switch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * What /login shows someone who is already signed in: who they are, and the
 * two ways on. It never redirects on its own — an invite or password-reset
 * "Sign in" can land here in a browser where somebody else is still signed
 * in, and silently continuing would put the new person into that account.
 */
export function SignedInCard({
  name,
  email,
  continueHref,
}: {
  name: string;
  email: string;
  continueHref: string;
}) {
  const [leaving, setLeaving] = useState(false);

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md flex flex-col items-center gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pinchy-logo.svg" alt="Pinchy" width={80} height={85} />

        <Card className="w-full">
          <CardHeader>
            <CardTitle>You&apos;re already signed in</CardTitle>
            <CardDescription>
              Signed in as <span className="font-medium text-foreground">{name}</span> ({email}).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {/* A full load, like a fresh sign-in: no client state carries over. */}
            <Button asChild className="w-full">
              <a href={continueHref}>Continue</a>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={leaving}
              onClick={async () => {
                setLeaving(true);
                // Signs out, wipes this browser's Pinchy storage and reloads
                // into /login, which then shows the sign-in form.
                await leaveAccount();
              }}
            >
              {leaving ? "Signing out..." : "Sign in as someone else"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
