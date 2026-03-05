"use client";

import Image from "next/image";
import { ReportIssueLink } from "@/components/report-issue-link";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-full max-w-md flex flex-col items-center gap-6 px-4">
        <Image src="/pinchy-logo.png" alt="Pinchy" width={80} height={85} priority />

        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">{error.message}</p>
        </div>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={reset}
            className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-2 cursor-pointer"
          >
            Try again
          </button>
          <ReportIssueLink error={error.message} />
        </div>
      </div>
    </div>
  );
}
