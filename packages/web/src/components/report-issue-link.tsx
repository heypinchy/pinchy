"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { buildGitHubIssueUrl, buildIssueBody, fetchDiagnostics } from "@/lib/github-issue";

interface ReportIssueLinkProps {
  error: string;
  statusCode?: number;
}

export function ReportIssueLink({ error, statusCode }: ReportIssueLinkProps) {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      let diagnostics;
      try {
        diagnostics = (await fetchDiagnostics()) ?? undefined;
      } catch {
        // Diagnostics fetch failed — continue without them
      }

      const context = { error, statusCode, page: pathname, diagnostics };
      const body = buildIssueBody(context);

      try {
        await navigator.clipboard.writeText(body);
        setCopied(true);
      } catch {
        // Clipboard write failed — still open GitHub
      }

      const url = buildGitHubIssueUrl(context);
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 5000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (copied) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground shrink-0">
        <Check className="size-3" />
        Copied — paste into the issue
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground underline underline-offset-2 cursor-pointer disabled:opacity-50 shrink-0"
    >
      {loading ? <Loader2 className="size-3 animate-spin" /> : <ExternalLink className="size-3" />}
      Report this issue
    </button>
  );
}
