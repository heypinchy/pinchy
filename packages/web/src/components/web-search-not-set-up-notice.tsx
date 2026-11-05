import Link from "next/link";
import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Shown wherever an agent holds web tools while no web-search provider is
 * configured (#1297). Page fetch works without one; search does not, and an
 * agent that cannot search should not be the first to tell the admin.
 */
export function WebSearchNotSetUpNotice() {
  return (
    <Alert>
      <Info className="size-4" />
      <AlertTitle>Web search isn&apos;t set up</AlertTitle>
      <AlertDescription>
        <p>
          This agent can read web pages it&apos;s given, but it can&apos;t search the web until an
          admin adds a Brave Search API key.{" "}
          <Link href="/settings?tab=integrations" className="underline hover:text-foreground">
            Set up web search →
          </Link>
        </p>
      </AlertDescription>
    </Alert>
  );
}
