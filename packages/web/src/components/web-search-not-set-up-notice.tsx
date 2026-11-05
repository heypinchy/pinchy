import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Shown wherever an agent holds web tools while no web-search provider is
 * configured (#1297). Page fetch works without one; search does not, and an
 * agent that cannot search should not be the first to tell the admin. Only
 * admins see it (agent creation and the Permissions tab are admin-only), so it
 * names the missing key rather than whoever should add it.
 */
export function WebSearchNotSetUpNotice() {
  return (
    <Alert>
      <Info className="size-4" />
      <AlertTitle>Web search isn&apos;t set up</AlertTitle>
      <AlertDescription>
        <p>
          Searching the web needs a Brave Search API key, and none is set up yet. Reading a web page
          works without one.{" "}
          {/* A plain anchor, not next/link: the agent settings page guards
              unsaved edits with onbeforeunload, which only a full navigation
              triggers. Same as the "Add an integration" link beside it. */}
          <a href="/settings?tab=integrations" className="underline hover:text-foreground">
            Set up web search →
          </a>
        </p>
      </AlertDescription>
    </Alert>
  );
}
